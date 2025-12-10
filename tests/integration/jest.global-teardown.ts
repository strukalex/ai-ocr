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
  // eslint-disable-next-line no-var
  var __BULLMQ_RESOURCES__:
    | {
        queues: Set<{ close: () => Promise<void> }>;
        workers: Set<{ close: () => Promise<void> }>;
        events: Set<{ close: () => Promise<void> }>;
      }
    | undefined;
}

export default async function globalTeardown(): Promise<void> {
  // Close BullMQ resources before tearing down Redis to avoid ECONNREFUSED spam.
  if (global.__BULLMQ_RESOURCES__) {
    const { queues, workers, events } = global.__BULLMQ_RESOURCES__;
    const closers = [
      ...Array.from(queues).map((q) => q.close()),
      ...Array.from(workers).map((w) => w.close()),
      ...Array.from(events).map((e) => e.close()),
    ];
    await Promise.allSettled(closers);
  }

  const containers = global.__TEST_CONTAINERS__;
  if (!containers) return;

  await Promise.allSettled([
    containers.postgres.stop(),
    containers.redis.stop(),
    containers.minio.stop(),
  ]);
}

