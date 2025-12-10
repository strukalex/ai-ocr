// Silence BullMQ Redis connections in contract tests.
jest.mock('bullmq', () => {
  class Queue {
    name: string;
    opts: any;
    add = jest.fn(async (jobName: string, data: any, options?: any) => ({
      id: 'mock-job',
      name: jobName,
      data,
      options,
    }));
    close = jest.fn(async () => undefined);

    constructor(name: string, opts?: any) {
      this.name = name;
      this.opts = opts;
    }
  }

  class Worker {
    close = jest.fn(async () => undefined);
    constructor(..._args: any[]) {}
  }

  class QueueEvents {
    close = jest.fn(async () => undefined);
    constructor(..._args: any[]) {}
  }

  class QueueScheduler {
    close = jest.fn(async () => undefined);
    constructor(..._args: any[]) {}
  }

  return { Queue, Worker, QueueEvents, QueueScheduler };
});

