import { LoggerService } from '@my-org/observability';
import { StorageService } from '@my-org/storage';
import axios from 'axios';
import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { PreprocessingService } from './preprocessing.service';

jest.mock('axios');

class MockRedis extends EventEmitter {
  status = 'ready';
  subscribed: string[] = [];

  async subscribe(channel: string): Promise<void> {
    this.subscribed.push(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscribed = this.subscribed.filter((c) => c !== channel);
  }

  async quit(): Promise<void> {
    this.status = 'end';
  }

  async connect(): Promise<void> {
    this.status = 'ready';
  }
}

let redisInstance: MockRedis;

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => {
    redisInstance = new MockRedis();
    return redisInstance;
  });
});

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('PreprocessingService (Python microservice integration)', () => {
  let service: PreprocessingService;
  let logger: jest.Mocked<LoggerService>;
  let storage: jest.Mocked<StorageService>;
  let workerAuth: { buildAuthHeader: jest.Mock };

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<LoggerService>;

    storage = {
      getDefaultBucket: jest.fn().mockReturnValue('documents'),
      uploadObject: jest.fn(),
      downloadObject: jest.fn(),
    } as unknown as jest.Mocked<StorageService>;

    workerAuth = {
      buildAuthHeader: jest.fn().mockReturnValue('Bearer token'),
    };

    mockedAxios.post.mockReset();
    service = new PreprocessingService(logger, storage, workerAuth as any);
  });

  it('uploads input, dispatches HTTP call, waits for Redis, and returns processed buffer', async () => {
    const processed = Buffer.from('processed-image');
    storage.downloadObject.mockResolvedValue(processed);
    storage.uploadObject.mockResolvedValue();

    mockedAxios.post.mockImplementation(async (_url, body: any) => {
      setImmediate(() => {
        redisInstance.emit(
          'message',
          body.callbackChannel,
          JSON.stringify({
            requestId: body.requestId,
            resultKey: body.resultKey,
            bucket: body.resultBucket,
            correctionAngleDeg: -7.25,
          }),
        );
      });
      return { status: 202 } as any;
    });

    const result = await service.preprocess({
      buffer: Buffer.from('input-image'),
      filename: 'scan.png',
      traceId: 'trace-123',
    });

    expect(storage.uploadObject).toHaveBeenCalledWith(
      expect.stringContaining('preprocess/input/'),
      expect.any(Buffer),
      expect.any(Object),
      'documents',
    );
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/preprocess'),
      expect.objectContaining({
        callbackChannel: expect.stringContaining('preprocess:results:'),
        resultBucket: 'documents',
        resultKey: expect.stringContaining('preprocess/output/'),
      }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(storage.downloadObject).toHaveBeenCalledWith(expect.stringContaining('preprocess/output/'), 'documents');
    expect(result.buffer).toEqual(processed);
    expect(result.correctionAngleDeg).toBeCloseTo(-7.25);
  });

  it('times out when no redis message arrives', async () => {
    process.env['PREPROCESSOR_TIMEOUT_MS'] = '500';
    process.env['ALLOW_PREPROCESSOR_TIMEOUT_FALLBACK'] = 'false';
    service = new PreprocessingService(logger, storage, workerAuth as any);
    mockedAxios.post.mockResolvedValue({ status: 202 } as any);

    const promise = service.preprocess({ buffer: Buffer.from('input-image'), filename: 'scan.png' });
    // attach handler immediately to avoid unhandled rejection event
    promise.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 750));
    await promise
      .then(() => {
        throw new Error('expected timeout rejection');
      })
      .catch((err) => {
        expect(err?.message ?? '').toMatch(/timed out/i);
      });
    delete process.env['PREPROCESSOR_TIMEOUT_MS'];
    delete process.env['ALLOW_PREPROCESSOR_TIMEOUT_FALLBACK'];
  }, 10000);
});
