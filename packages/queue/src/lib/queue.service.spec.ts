import { QueueService } from './queue.service';
import { DEFAULT_JOB_OPTIONS } from './retry.config';

jest.mock('bullmq', () => {
  class MockQueue {
    name: string;
    options: any;
    constructor(name: string, options?: any) {
      this.name = name;
      this.options = options;
    }
    add = jest.fn();
    getJob = jest.fn();
  }
  class MockWorker {}
  return { Queue: MockQueue, Worker: MockWorker };
});

describe('QueueService', () => {
  const service = new QueueService({
    queuePrefix: 'test',
    redisUrl: 'redis://localhost:6379',
  });
  const jobExistsError = Object.assign(new Error('Job jobId already exists'), {
    name: 'JobIdAlreadyExistsError',
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns existing job when jobId matches', async () => {
    const existingJob = { id: 'job-existing', getState: jest.fn().mockResolvedValue('waiting') } as any;
    const queueMock = {
      add: jest.fn().mockRejectedValue(jobExistsError),
      getJob: jest.fn().mockResolvedValue(existingJob),
    } as any;

    const job = await service.enqueue(queueMock, 'intake', { foo: 'bar' }, { jobId: 'abc' });

    expect(job).toBe(existingJob);
    expect(queueMock.add).toHaveBeenCalledTimes(1);
  });

  it('enqueues new job with merged defaults when no existing job', async () => {
    const addedJob = { id: 'job-new' };
    const queueMock = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue(addedJob),
    } as any;

    const job = await service.enqueue(queueMock, 'intake', { foo: 'bar' }, { jobId: 'abc', attempts: 7 });

    expect(queueMock.add).toHaveBeenCalledWith(
      'intake',
      expect.objectContaining({ foo: 'bar' }),
      expect.objectContaining({
        jobId: 'abc',
        attempts: 7,
        backoff: expect.objectContaining({ type: 'exponential' }),
      }),
    );
    expect(job).toBe(addedJob);
  });

  it('applies default backoff profile when options are omitted', async () => {
    const queueMock = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue({ id: 'job-defaults' }),
    } as any;

    await service.enqueue(queueMock, 'intake', { foo: 'bar' });

    const optionsUsed = (queueMock.add as jest.Mock).mock.calls[0][2];
    expect(optionsUsed.attempts).toBe(DEFAULT_JOB_OPTIONS.attempts);
    expect(optionsUsed.backoff).toEqual(DEFAULT_JOB_OPTIONS.backoff);
  });

  it('creates queue with redis url and prefix', () => {
    const svc = new QueueService({ redisUrl: 'redis://test:6379', queuePrefix: 'pref' });
    const queue = svc.createQueue('test');
    const opts = (queue as unknown as any).options;
    expect(opts?.connection?.url).toBe('redis://test:6379');
    expect(opts?.prefix).toBe('pref');
  });

  it('re-enqueues when existing job is terminal', async () => {
    const terminalJob = {
      id: 'job-old',
      getState: jest.fn().mockResolvedValue('failed'),
      remove: jest.fn(),
    } as any;
    const queueMock = {
      add: jest.fn().mockRejectedValueOnce(jobExistsError).mockResolvedValueOnce({ id: 'job-new' }),
      getJob: jest.fn().mockResolvedValue(terminalJob),
    } as any;

    const job = await service.enqueue(queueMock, 'intake', { foo: 'bar' }, { jobId: 'abc' });

    expect(queueMock.getJob).toHaveBeenCalledWith('abc');
    expect(queueMock.add).toHaveBeenCalledTimes(2);
    expect(job.id).toBe('job-new');
  });

  it('retries add when existing job disappears between checks', async () => {
    const queueMock = {
      add: jest.fn().mockRejectedValueOnce(jobExistsError).mockResolvedValueOnce({ id: 'job-new' }),
      getJob: jest.fn().mockResolvedValue(null),
    } as any;

    const job = await service.enqueue(queueMock, 'intake', { foo: 'bar' }, { jobId: 'abc' });

    expect(queueMock.add).toHaveBeenCalledTimes(2);
    expect(queueMock.getJob).toHaveBeenCalledWith('abc');
    expect(job.id).toBe('job-new');
  });

  it('sanitizes disallowed characters in custom jobId', async () => {
    const queueMock = {
      getJob: jest.fn().mockResolvedValue(null),
      add: jest.fn().mockResolvedValue({ id: 'job-new' }),
    } as any;

    await service.enqueue(queueMock, 'intake', { foo: 'bar' }, { jobId: 'doc:1' });

    const optionsUsed = (queueMock.add as jest.Mock).mock.calls[0][2];
    expect(optionsUsed.jobId).toBe('doc-1');
  });
});


