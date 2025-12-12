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
    const reusableStates = new Set(['waiting', 'active', 'delayed', 'paused']);

    if (jobOptions.jobId) {
      const sanitized = sanitizeJobId(jobOptions.jobId);
      jobOptions.jobId = sanitized;
    } else {
      return queue.add(name as any, data as any, jobOptions);
    }

    const jobId = jobOptions.jobId;

    // First, optimistically try to add the job. BullMQ guarantees uniqueness on jobId.
    try {
      return await queue.add(name as any, data as any, jobOptions);
    } catch (err) {
      if (!isJobIdAlreadyExistsError(err)) {
        throw err;
      }
    }

    // A job with this id already exists. Inspect and act based on its latest state.
    const existing = await queue.getJob(jobId);
    if (!existing) {
      // It was removed after the first add attempt; retry add once.
      return queue.add(name as any, data as any, jobOptions);
    }

    const state = await existing.getState();
    if (reusableStates.has(state)) {
      return existing as Job;
    }

    // Terminal state: remove and re-add to allow replay. If removal races, swallow and retry add.
    try {
      await existing.remove();
    } catch {
      /* best-effort remove; continue to re-add */
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

function sanitizeJobId(jobId: string): string {
  // BullMQ disallows certain characters (e.g., ':'); normalize to a safe token.
  return jobId.replace(/[:\s]+/g, '-');
}

function isJobIdAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'JobIdAlreadyExistsError' ||
    error.message?.toLowerCase().includes('jobid') ||
    error.message?.toLowerCase().includes('already exists')
  );
}

