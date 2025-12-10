import type { StartedTestContainer } from 'testcontainers';

type TestEnvironments = {
  postgres: StartedTestContainer;
  redis: StartedTestContainer;
  minio: StartedTestContainer;
  env: Record<string, string>;
};

export {};

declare global {
  // eslint-disable-next-line no-var
  var __TEST_CONTAINERS__: TestEnvironments | undefined;
}

export default async function globalTeardown(): Promise<void> {
  const containers = global.__TEST_CONTAINERS__;
  if (!containers) return;

  await Promise.allSettled([
    containers.postgres.stop(),
    containers.redis.stop(),
    containers.minio.stop(),
  ]);
}

