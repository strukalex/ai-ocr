import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { Client as MinioClient } from 'minio';
import path from 'path';
import { setTimeout as wait } from 'timers/promises';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface TestEnvironments {
  postgres: StartedTestContainer;
  redis: StartedTestContainer;
  minio: StartedTestContainer;
  env: Record<string, string>;
}

export {};

declare global {
  // eslint-disable-next-line no-var
  var __TEST_CONTAINERS__: TestEnvironments | undefined;
}

async function ensureMinioBucket(client: MinioClient, bucket: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const exists = await client.bucketExists(bucket);
      if (exists) return;
      await client.makeBucket(bucket);
      return;
    } catch (err) {
      if (attempt === 9) throw err;
      await wait(500);
    }
  }
}

export default async function globalSetup(): Promise<void> {
  const networkAlias = `ai-ocr-int-${randomUUID().slice(0, 8)}`;

  const postgres = await new GenericContainer('postgres:15-alpine')
    .withEnvironment({
      POSTGRES_DB: 'aiocr',
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
    .start();

  const redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  const minio = await new GenericContainer('minio/minio:RELEASE.2024-10-02T17-50-41Z')
    .withEnvironment({
      MINIO_ROOT_USER: 'minioadmin',
      MINIO_ROOT_PASSWORD: 'minioadmin',
    })
    .withCommand(['server', '/data', '--console-address', ':9001'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forLogMessage('API: http://'))
    .start();

  const postgresUrl = `postgresql://test:test@${postgres.getHost()}:${postgres.getMappedPort(5432)}/aiocr?schema=public`;
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  const minioEndpoint = minio.getHost();
  const minioPort = minio.getMappedPort(9000);

  const minioClient = new MinioClient({
    endPoint: minioEndpoint,
    port: minioPort,
    useSSL: false,
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
  });
  await ensureMinioBucket(minioClient, 'documents');

  const sharedEnv = {
    DATABASE_URL: postgresUrl,
    REDIS_URL: redisUrl,
    MINIO_ENDPOINT: minioEndpoint,
    MINIO_PORT: String(minioPort),
    MINIO_ACCESS_KEY: 'minioadmin',
    MINIO_SECRET_KEY: 'minioadmin',
    MINIO_BUCKET: 'documents',
    MINIO_USE_SSL: 'false',
  };

  Object.assign(process.env, sharedEnv);

  // Persist env for tests and for globalTeardown.
  global.__TEST_CONTAINERS__ = {
    postgres,
    redis,
    minio,
    env: sharedEnv,
  };

  // Run Prisma schema sync against the containerized Postgres.
  await execFileAsync(
    'pnpm',
    ['prisma', 'db', 'push', '--schema', path.join(process.cwd(), 'packages/database/prisma/schema.prisma')],
    { env: { ...process.env, ...sharedEnv } },
  );

  // Write a temp env file Jest can source if needed (not strictly required but helpful for debugging).
  const envFile = Object.entries(sharedEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const envPath = path.join(process.cwd(), 'tests/integration/.env.testcontainers');
  await fs.writeFile(envPath, envFile);
}

