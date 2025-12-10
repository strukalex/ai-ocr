import { createHash, randomUUID } from 'crypto';
import { spawn, ChildProcess, execSync } from 'child_process';
import { existsSync } from 'fs';
import http from 'http';
import path from 'path';

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

  afterEach(async () => {
    await pythonProc?.kill('SIGTERM');
    pythonProc = undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  afterAll(async () => {
    await minio?.stop();
    await redis?.stop();
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
    try {
      execSync(`${pythonBin} - <<PY\nimport sys\nprint(sys.version)\nPY`, { stdio: 'ignore' });
    } catch {
      throw new Error(`Python is required for preprocessing integration test (tried ${pythonBin})`);
    }

    if (pythonDepsReady) return;
    try {
      execSync(
        `${pythonBin} -m pip install --quiet --upgrade pip && ${pythonBin} -m pip install --quiet fastapi "uvicorn[standard]" minio redis opencv-python-headless numpy`,
        { stdio: 'ignore' },
      );
      pythonDepsReady = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Skipping preprocessing test: python deps missing', err);
      throw err;
    }
  };

  const startPythonPreprocessService = async (): Promise<{ url: string }> => {
    ensurePythonDeps();
    const pythonBin = resolvePythonBin();
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const port = 18081;
    const script = `
import asyncio
import os
import sys
import base64
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

    // crude wait for server readiness
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return { url: `http://127.0.0.1:${port}` };
  };

  it('dispatches to python service, stores processed artifact, and returns angle', async () => {
    const { url } = await startPythonPreprocessService();
    process.env['PREPROCESSOR_URL'] = url;
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
  });

  it('times out when callback message is not published', async () => {
    const port = 18082;
    process.env['PREPROCESSOR_URL'] = `http://127.0.0.1:${port}`;
    process.env['PREPROCESSOR_REDIS_URL'] = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    process.env['PREPROCESSOR_RESPONSE_CHANNEL'] = 'preprocess:results-timeout';
    process.env['PREPROCESSOR_TIMEOUT_MS'] = '500';

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
  });
});

