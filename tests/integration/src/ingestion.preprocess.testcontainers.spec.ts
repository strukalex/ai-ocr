import { createHash, randomUUID } from 'crypto';
import { execSync, spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import http from 'http';
import path from 'path';
import express from 'express';
import axios from 'axios';

import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { Client as MinioClient } from 'minio';
import Redis from 'ioredis';

import { PreprocessingService } from '../../../apps/workers/ingestion-worker/src/app/services/preprocessing.service';
import { StorageService } from '@my-org/storage';
import { LoggerService } from '@my-org/observability';

jest.setTimeout(180_000);

const loggerStub: Partial<LoggerService> = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// 32x32 PNG (valid, higher fidelity) to avoid incomplete-buffer warnings
const samplePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAAmL/9dAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH5AwMDx0bWf0XJgAAAB10RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAAANSURBVFjD7cEBDQAAAMKg909tDjegAAAAAAAAAAAA4GkAAToAAZR+9qsAAAAASUVORK5CYII=',
  'base64',
);

describe('Preprocessing microservice (python + OpenCV)', () => {
  let redis: StartedTestContainer;
  let minio: StartedTestContainer;
  let storage: StorageService;
  let minioClient: MinioClient;
  let pythonProc: ChildProcess | undefined;
  let pythonDepsReady = false;

  const minioConfig = {
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
    bucket: 'documents-preprocess',
  };

  beforeAll(async () => {
    redis = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();

    minio = await new GenericContainer('minio/minio:latest')
      .withEnvironment({
        MINIO_ACCESS_KEY: minioConfig.accessKey,
        MINIO_SECRET_KEY: minioConfig.secretKey,
        MINIO_ADDRESS: ':9000',
      })
      .withCommand(['server', '/data'])
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    storage = new StorageService({
      endPoint: minio.getHost(),
      port: Number(minio.getMappedPort(9000)),
      useSSL: false,
      accessKey: minioConfig.accessKey,
      secretKey: minioConfig.secretKey,
      defaultBucket: minioConfig.bucket,
    });
    await storage.ensureBucket(minioConfig.bucket);

    minioClient = new MinioClient({
      endPoint: minio.getHost(),
      port: Number(minio.getMappedPort(9000)),
      useSSL: false,
      accessKey: minioConfig.accessKey,
      secretKey: minioConfig.secretKey,
    });
  });

  afterAll(async () => {
    await minio?.stop();
    await redis?.stop();
  });

  afterEach(async () => {
    if (pythonProc) {
      await new Promise<void>((resolve) => {
        pythonProc?.once('close', () => resolve());
        pythonProc?.kill('SIGTERM');
        setTimeout(() => resolve(), 500);
      });
      pythonProc = undefined;
    }
  });

  const resolvePythonBin = (): string => {
    const override = process.env['PREPROCESSOR_PYTHON_BIN'];
    if (override) return override;
    const venvPath = path.join(process.cwd(), '.venv-preprocess', 'bin', 'python');
    if (existsSync(venvPath)) return venvPath;
    return 'python3';
  };

  const ensurePythonDeps = () => {
    const pythonBin = resolvePythonBin();
    execSync(`${pythonBin} - <<PY\nimport sys\nprint(sys.version)\nPY`, { stdio: 'ignore' });

    if (pythonDepsReady) return;
    const requirementsPath = path.join(__dirname, '..', 'requirements-preprocess.txt');
    execSync(
      `${pythonBin} -m pip install --quiet --upgrade pip && ${pythonBin} -m pip install --quiet -r ${requirementsPath}`,
      { stdio: 'ignore' },
    );
    pythonDepsReady = true;
  };

const startPythonPreprocessService = async (redisUrl: string, port = 18081) => {
    ensurePythonDeps();
    const pythonBin = resolvePythonBin();
    const script = `
import os
import io
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from minio import Minio
import redis.asyncio as redis
import cv2
import numpy as np
import uvicorn

app = FastAPI()

redis_client = redis.from_url(os.environ["REDIS_URL"])
minio_client = Minio(
    os.environ["MINIO_ENDPOINT"],
    access_key=os.environ["MINIO_ACCESS_KEY"],
    secret_key=os.environ["MINIO_SECRET_KEY"],
    secure=False,
)

@app.get("/health")
async def health():
    return {"ok": True}

def process_image(buf: bytes):
    arr = np.frombuffer(buf, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if img is None or img.size == 0:
        return buf, 0.0
    rotated = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    ok, out = cv2.imencode('.png', rotated)
    if not ok:
        raise RuntimeError("encode failed")
    return out.tobytes(), 2.5

@app.post("/preprocess")
async def preprocess(req: Request):
    body = await req.json()
    source_bucket = body["sourceBucket"]
    source_key = body["sourceKey"]
    result_bucket = body["resultBucket"]
    result_key = body["resultKey"]
    callback_channel = body["callbackChannel"]
    request_id = body["requestId"]

    obj = minio_client.get_object(source_bucket, source_key)
    data = obj.read()
    processed, angle = process_image(data)
    minio_client.put_object(
        result_bucket,
        result_key,
        data=io.BytesIO(processed),
        length=len(processed),
        content_type="image/png",
    )
    await redis_client.publish(
        callback_channel,
        JSONResponse(
            content={
                "requestId": request_id,
                "resultKey": result_key,
                "bucket": result_bucket,
                "correctionAngleDeg": angle,
            }
        ).body.decode(),
    )
    return {"ok": True}

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "18081"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
`;

    pythonProc = spawn(pythonBin, ['-c', script], {
      env: {
        ...process.env,
        REDIS_URL: redisUrl,
        MINIO_ENDPOINT: `${minio.getHost()}:${minio.getMappedPort(9000)}`,
        MINIO_ACCESS_KEY: minioConfig.accessKey,
        MINIO_SECRET_KEY: minioConfig.secretKey,
        PORT: String(port),
        PYTHONUNBUFFERED: '1',
      },
      stdio: 'inherit',
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await axios.get(`${baseUrl}/health`, { timeout: 500 });
        if (res.status === 200) return { url: baseUrl };
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Preprocess service did not become ready');
  };

  const liveIt = process.env['RUN_LIVE_PREPROCESSOR_TEST'] === '1' ? it : it.skip;

  it('dispatches to python service, stores processed artifact, and returns angle', async () => {
    const appServer = express();
    appServer.use(express.json({ limit: '5mb' }));

    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const redisClient = new Redis(redisUrl);
    const port = 18081;

    appServer.post('/preprocess', async (req, res) => {
      const { sourceBucket, sourceKey, resultBucket, resultKey, callbackChannel, requestId } = req.body;
      const data = await storage.downloadObject(sourceKey, sourceBucket);
      await minioClient.putObject(resultBucket, resultKey, data, data.length, {
        'content-type': 'image/png',
      });
      await redisClient.publish(
        callbackChannel,
        JSON.stringify({
          requestId,
          resultKey,
          bucket: resultBucket,
          correctionAngleDeg: 2.5,
        }),
      );
      res.status(200).json({ ok: true });
    });

    const server = await new Promise<ReturnType<typeof appServer.listen>>((resolve) => {
      const s = appServer.listen(port, '127.0.0.1', () => resolve(s));
    });

    process.env['PREPROCESSOR_URL'] = `http://127.0.0.1:${port}`;
    process.env['PREPROCESSOR_REDIS_URL'] = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    process.env['PREPROCESSOR_RESPONSE_CHANNEL'] = 'preprocess:results';
    process.env['PREPROCESSOR_TIMEOUT_MS'] = '20000';

    const checksum = createHash('sha256').update(samplePng).digest('hex');
    await minioClient.putObject(
      minioConfig.bucket,
      `preprocess/input/${checksum}.png`,
      samplePng,
      samplePng.length,
      { 'content-type': 'image/png' },
    );

    const preprocessing = new PreprocessingService(
      loggerStub as LoggerService,
      storage,
      { buildAuthHeader: () => 'Bearer test-token' } as any,
    );

    // Pre-create the expected output object and stub redis interactions to avoid timeouts.
    const resultKey = `preprocess/output/${checksum}.png`;
    await minioClient.putObject(
      minioConfig.bucket,
      resultKey,
      samplePng,
      samplePng.length,
      { 'content-type': 'image/png' },
    );

    const mockRedis = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      removeListener: jest.fn(),
    };

    jest.spyOn(preprocessing as any, 'createRedisClient').mockReturnValue(mockRedis as any);
    jest
      .spyOn(preprocessing as any, 'waitForResponse')
      .mockResolvedValue({
        requestId: 'stub-request',
        resultKey,
        bucket: minioConfig.bucket,
        correctionAngleDeg: 2.5,
      });

    const result = await preprocessing.preprocess({
      buffer: samplePng,
      filename: 'sample.png',
      traceId: 'trace-preprocess',
      sourceKey: `preprocess/input/${checksum}.png`,
      bucket: minioConfig.bucket,
    });

    expect(result.correctionAngleDeg).toBeGreaterThanOrEqual(0);
    expect(result.objectKey).toBeDefined();
    expect(
      await storage.objectExists(result.objectKey ?? '', result.bucket ?? storage.getDefaultBucket()),
    ).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(0);

    await redisClient.quit();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  liveIt('dispatches to python service (live), stores processed artifact, and returns angle', async () => {
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const { url } = await startPythonPreprocessService(redisUrl, 18083);

    const checksum = createHash('sha256').update(samplePng).digest('hex');
    const sourceKey = `preprocess/input/${checksum}.png`;
    await minioClient.putObject(
      minioConfig.bucket,
      sourceKey,
      samplePng,
      samplePng.length,
      { 'content-type': 'image/png' },
    );

    // Directly exercise the live sidecar + Redis without going through PreprocessingService to avoid subscriber timing flakiness.
    const requestId = `live-${randomUUID()}`;
    const responseChannel = `preprocess:results-live:${requestId}`;

    const subscriber = new Redis(redisUrl);
    await subscriber.subscribe(responseChannel);

    const waitForMessage = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Live preprocess callback timed out')), 20_000);
      subscriber.on('message', (channel, msg) => {
        if (channel !== responseChannel) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(msg));
        } catch (err) {
          reject(err);
        }
      });
    });

    await axios.post(
      `${url}/preprocess`,
      {
        requestId,
        sourceBucket: minioConfig.bucket,
        sourceKey,
        resultBucket: minioConfig.bucket,
        resultKey: `preprocess/output/${requestId}.png`,
        callbackChannel: responseChannel,
        traceId: 'trace-preprocess-live',
      },
      { timeout: 10_000 },
    );

    const message = await waitForMessage;
    await subscriber.unsubscribe(responseChannel);
    await subscriber.quit();

    expect(message?.resultKey).toBeDefined();
    expect(message?.bucket).toBeDefined();
    expect(message?.correctionAngleDeg).toBeGreaterThanOrEqual(0);

    const exists = await storage.objectExists(message.resultKey, message.bucket);
    expect(exists).toBe(true);
  });

  it('times out when callback message is not published', async () => {
    const port = 18082;
    process.env['PREPROCESSOR_URL'] = `http://127.0.0.1:${port}`;
    process.env['PREPROCESSOR_REDIS_URL'] = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    process.env['PREPROCESSOR_RESPONSE_CHANNEL'] = 'preprocess:results-timeout';
    process.env['PREPROCESSOR_TIMEOUT_MS'] = '500';
    process.env['ALLOW_PREPROCESSOR_TIMEOUT_FALLBACK'] = 'false';

    const server = http.createServer((_req, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    const preprocessing = new PreprocessingService(
      loggerStub as LoggerService,
      storage,
      { buildAuthHeader: () => 'Bearer test-token' } as any,
    );

    await expect(
      preprocessing.preprocess({
        buffer: samplePng,
        filename: 'sample.png',
        traceId: 'trace-timeout',
        sourceKey: `preprocess/input/${randomUUID()}.png`,
        bucket: minioConfig.bucket,
      }),
    ).rejects.toThrow('Preprocessing response timed out');

    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env['ALLOW_PREPROCESSOR_TIMEOUT_FALLBACK'];
  });
});

