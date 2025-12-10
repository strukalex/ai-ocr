import { Queue, Worker } from 'bullmq';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { STANDARD_BACKOFF, withDefaultJobOptions } from '@my-org/queue';

jest.setTimeout(60_000);

describe('Queue retry/backoff defaults (testcontainers)', () => {
  let redis: StartedTestContainer;

  beforeAll(async () => {
    redis = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it('applies exponential backoff and retains failed jobs (removeOnFail=false)', async () => {
    const connection = { host: redis.getHost(), port: redis.getMappedPort(6379) };
    const queue = new Queue('retry-defaults', { connection });

    const failureEvents: { attempt: number; ts: number }[] = [];
    const worker = new Worker(
      'retry-defaults',
      async () => {
        failureEvents.push({ attempt: failureEvents.length + 1, ts: Date.now() });
        throw new Error('boom');
      },
      { connection },
    );

    const jobId = 'retry-job-1';
    await queue.add('task', { ok: false }, withDefaultJobOptions({ attempts: 2, jobId }));

    await new Promise<void>((resolve) => {
      worker.on('failed', async (job) => {
        if (job?.id === jobId && job.attemptsMade >= 2) {
          resolve();
        }
      });
    });

    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job?.attemptsMade).toBe(2);
    expect(await job?.getState()).toBe('failed');
    expect(job?.opts.backoff).toEqual(STANDARD_BACKOFF);
    expect(job?.opts.removeOnFail).toBe(false);

    // Coarse check that backoff delayed retry (>= configured delay).
    expect(failureEvents.length).toBeGreaterThanOrEqual(2);
    if (failureEvents.length >= 2) {
      const delta = failureEvents[1].ts - failureEvents[0].ts;
      expect(delta).toBeGreaterThanOrEqual((STANDARD_BACKOFF as any).delay ?? 1000);
    }

    await worker.close();
    await queue.close();
  });
});

