import { JobsOptions } from 'bullmq';

/**
 * Standardized backoff profile for ingestion/intake queue jobs.
 * Exponential backoff keeps retries spaced without overwhelming downstream systems.
 */
export const STANDARD_BACKOFF: JobsOptions['backoff'] = {
  type: 'exponential',
  delay: 1000,
};

/**
 * Default job options applied to all queue.enqueue calls unless overridden.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: STANDARD_BACKOFF,
  // Keep completed jobs for 1 day so they appear in Bull Board.
  removeOnComplete: { age: 60 * 60 * 24 },
  removeOnFail: false,
};

/**
 * Merge provided options with sensible defaults. Idempotency-aware jobId can be passed separately.
 */
export const withDefaultJobOptions = (options?: JobsOptions): JobsOptions => ({
  ...DEFAULT_JOB_OPTIONS,
  ...options,
});

