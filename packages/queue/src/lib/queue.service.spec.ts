import { QueueService } from './queue.service';
import { Queue } from 'bullmq';

jest.mock('bullmq', () => {
  class MockQueue {
    name: string;
    options: any;
    constructor(name: string, options?: any) {
      this.name = name;
      this.options = options;
    }
    add = jest.fn();
  }
  class MockWorker {}
  return { Queue: MockQueue, Worker: MockWorker };
});

describe('QueueService', () => {
  it('creates queue with redis url from env', () => {
    const svc = new QueueService({ redisUrl: 'redis://test:6379', queuePrefix: 'pref' });
    const queue = svc.createQueue('test');
    const opts = (queue as unknown as any).options;
    expect(opts?.connection?.url).toBe('redis://test:6379');
    expect(opts?.prefix).toBe('pref');
  });
});

