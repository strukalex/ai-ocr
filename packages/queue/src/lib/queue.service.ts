import { Inject, Injectable } from '@nestjs/common';
import {
  Job,
  JobsOptions,
  Processor,
  Queue,
  QueueOptions,
  Worker,
  WorkerOptions,
} from 'bullmq';
import { withDefaultJobOptions } from './retry.config';
import { QUEUE_OPTIONS_TOKEN } from './queue.tokens';

export interface QueueModuleOptions {
  redisUrl?: string;
  queuePrefix?: string;
}

@Injectable()
export class QueueService {
  constructor(
    @Inject(QUEUE_OPTIONS_TOKEN) private readonly options: QueueModuleOptions = {},
  ) {}

  createQueue(name: string, queueOptions?: QueueOptions): Queue {
    return new Queue(name, {
      ...this.buildBaseOptions(),
      ...queueOptions,
    });
  }

  createWorker<T = unknown>(
    queueName: string,
    processor: Processor<T>,
    workerOptions?: Partial<WorkerOptions>,
  ): Worker<T> {
    return new Worker<T>(queueName, processor, {
      ...this.buildBaseOptions(),
      ...workerOptions,
    });
  }

  async enqueue<T = unknown>(
    queue: Queue<T>,
    name: string,
    data: T,
    options?: JobsOptions,
  ): Promise<Job> {
    const jobOptions = withDefaultJobOptions(options);

    /**
     * Idempotency: reuse an existing active job with the same id. If the prior job
     * is terminal (failed/completed), enqueue a fresh one so manual replays are not
     * blocked by old entries.
     */
    if (jobOptions.jobId) {
      const existing = await queue.getJob(jobOptions.jobId);
      if (existing) {
        const state = await existing.getState();
        const reusableStates = new Set(['waiting', 'active', 'delayed', 'paused']);
        if (reusableStates.has(state)) {
          return existing as Job;
        }
      }
    }

    return queue.add(name as any, data as any, jobOptions);
  }

  private buildBaseOptions(): QueueOptions {
    return {
      connection: {
        url: this.options.redisUrl ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
      },
      prefix: this.options.queuePrefix ?? 'bull',
    };
  }
}

