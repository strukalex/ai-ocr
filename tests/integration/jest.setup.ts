// Increase timeout for container startup and Prisma migrations.
jest.setTimeout(120000);

// Track BullMQ resources so globalTeardown can close them before Redis stops.
import type { Queue, Worker, QueueEvents } from 'bullmq';

declare global {
  // eslint-disable-next-line no-var
  var __BULLMQ_RESOURCES__:
    | {
        queues: Set<Queue>;
        workers: Set<Worker>;
        events: Set<QueueEvents>;
      }
    | undefined;
}

const resources =
  global.__BULLMQ_RESOURCES__ ??
  (global.__BULLMQ_RESOURCES__ = {
    queues: new Set<Queue>(),
    workers: new Set<Worker>(),
    events: new Set<QueueEvents>(),
  });

jest.mock('bullmq', () => {
  const actual = jest.requireActual<typeof import('bullmq')>('bullmq');

  class TrackedQueue extends actual.Queue {
    constructor(...args: ConstructorParameters<typeof actual.Queue>) {
      super(...args);
      resources.queues.add(this as unknown as Queue);
    }

    override async close(
      ...args: Parameters<typeof actual.Queue.prototype.close>
    ): Promise<any> {
      resources.queues.delete(this as unknown as Queue);
      return super.close(...args);
    }
  }

  class TrackedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      resources.workers.add(this as unknown as Worker);
    }

    override async close(
      ...args: Parameters<typeof actual.Worker.prototype.close>
    ): Promise<any> {
      resources.workers.delete(this as unknown as Worker);
      return super.close(...args);
    }
  }

  class TrackedQueueEvents extends actual.QueueEvents {
    constructor(...args: ConstructorParameters<typeof actual.QueueEvents>) {
      super(...args);
      resources.events.add(this as unknown as QueueEvents);
    }

    override async close(
      ...args: Parameters<typeof actual.QueueEvents.prototype.close>
    ): Promise<any> {
      resources.events.delete(this as unknown as QueueEvents);
      return super.close(...args);
    }
  }

  return {
    ...actual,
    Queue: TrackedQueue,
    Worker: TrackedWorker,
    QueueEvents: TrackedQueueEvents,
  };
});

