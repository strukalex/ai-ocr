import { createHash } from 'crypto';
import { ChildProcess, execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import axios from 'axios';

import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { Client as MinioClient } from 'minio';
import Redis from 'ioredis';

import { PreprocessingService } from '../../../apps/workers/ingestion-worker/src/app/services/preprocessing.service';
import { StorageService } from '@my-org/storage';
import { LoggerService } from '@my-org/observability';
import { WorkerAuthService } from '../../../apps/workers/ingestion-worker/src/app/auth/worker-auth.service';

jest.setTimeout(180_000);

// 1x1 PNG (valid)
const samplePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8/5+hHgAHggJ/PxNVGAAAAABJRU5ErkJggg==',
  'base64',
);

const loggerStub: Partial<LoggerService> = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

describe('Preprocessing pipeline with python sidecar (testcontainers)', () => {
  let redis: StartedTestContainer;
  let minio: StartedTestContainer;
  let storage: StorageService;
  let minioClient: MinioClient;
  let pythonProc: ChildProcess | undefined;

  const minioConfig = {
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
    bucket: 'documents-preprocess-pipeline',
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
        MINIO_KMS_SECRET_KEY:
          'minio-test-key:voi2eYflLnCN97BhGIIAwRJJZA/jMxSSrlpCNdLN72Y=',
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
      enforceSse: true,
      sseAlgorithm: 'AES256',
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
    // Fail fast if Python is unavailable
    execSync(`${pythonBin} - <<PY\nimport sys\nprint(sys.version)\nPY`, { stdio: 'ignore' });

    const requirementsPath = path.join(__dirname, '..', 'requirements-preprocess.txt');
    execSync(
      `${pythonBin} -m pip install --quiet --upgrade pip && ${pythonBin} -m pip install --quiet -r ${requirementsPath}`,
      { stdio: 'ignore' },
    );
  };

  const startPythonPreprocessService = async (redisUrl: string, port = 18085) => {
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
    port = int(os.environ.get("PORT", "18085"))
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

  it('dispatches through the python sidecar, stores processed artifact, and returns angle', async () => {
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    const { url } = await startPythonPreprocessService(redisUrl, 18085);

    process.env['PREPROCESSOR_URL'] = url;
    process.env['PREPROCESSOR_REDIS_URL'] = redisUrl;
    process.env['PREPROCESSOR_RESPONSE_CHANNEL'] = 'preprocess:results-pipeline';
    process.env['PREPROCESSOR_TIMEOUT_MS'] = '20000';

    const preprocessing = new PreprocessingService(
      loggerStub as LoggerService,
      storage,
      { buildAuthHeader: () => 'Bearer test-token' } as unknown as WorkerAuthService,
    );

    const checksum = createHash('sha256').update(samplePng).digest('hex');
    const result = await preprocessing.preprocess({
      buffer: samplePng,
      filename: 'sample.png',
      traceId: 'trace-preprocess-pipeline',
      bucket: minioConfig.bucket,
    });

    expect(result.objectKey).toBeDefined();
    expect(result.bucket).toBe(minioConfig.bucket);
    // Angle may be 0 for minimal test image; assert callback delivered a numeric value.
    expect(result.correctionAngleDeg).toBeGreaterThanOrEqual(0);
    expect(await storage.objectExists(result.objectKey ?? '', result.bucket ?? minioConfig.bucket)).toBe(true);

    const processed = await storage.downloadObject(result.objectKey ?? '', result.bucket ?? minioConfig.bucket);
    expect(processed.length).toBeGreaterThan(0);
  });
});

