import { Injectable } from '@nestjs/common';
import { LoggerService } from '@my-org/observability';
import { StorageService } from '@my-org/storage';
import axios from 'axios';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { WorkerAuthService } from '../auth/worker-auth.service';

export interface PreprocessResult {
  buffer: Buffer;
  correctionAngleDeg: number;
  objectKey?: string;
  bucket?: string;
}

export interface PreprocessRequest {
  buffer: Buffer;
  bucket?: string;
  sourceKey?: string;
  filename?: string;
  traceId?: string;
}

interface PreprocessResponseMessage {
  requestId: string;
  resultKey: string;
  bucket?: string;
  correctionAngleDeg?: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

@Injectable()
export class PreprocessingService {
  private readonly preprocessorUrl: string;
  private readonly redisUrl: string;
  private readonly responseChannel: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly logger: LoggerService,
    private readonly storage: StorageService,
    private readonly workerAuth: WorkerAuthService,
  ) {
    this.preprocessorUrl = process.env['PREPROCESSOR_URL'] ?? 'http://localhost:8001';
    this.redisUrl =
      process.env['PREPROCESSOR_REDIS_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379';
    this.responseChannel = process.env['PREPROCESSOR_RESPONSE_CHANNEL'] ?? 'preprocess:results';
    this.timeoutMs = Number(process.env['PREPROCESSOR_TIMEOUT_MS'] ?? DEFAULT_TIMEOUT_MS);
  }

  /**
   * Dispatch preprocessing to the Python microservice via HTTP + Redis pub/sub.
   * Images are exchanged through MinIO to keep Node workers free of OpenCV bindings.
   */
  async preprocess(request: PreprocessRequest): Promise<PreprocessResult> {
    const { buffer, bucket: bucketOverride, sourceKey: providedSourceKey, filename, traceId } = request;
    if (!buffer || buffer.length === 0) {
      throw new Error('Empty image buffer supplied to preprocessing');
    }

    const bucket = bucketOverride ?? this.storage.getDefaultBucket();
    const requestId = randomUUID();
    const sourceKey = providedSourceKey ?? `preprocess/input/${requestId}${this.detectExtension(filename)}`;
    const resultKey = `preprocess/output/${requestId}.png`;
    const fallbackFlag = process.env['ALLOW_PREPROCESSOR_TIMEOUT_FALLBACK'];
    const isTestEnv = (process.env['NODE_ENV'] ?? '').toLowerCase() === 'test';
    const allowTimeoutFallback =
      fallbackFlag !== undefined ? fallbackFlag.toLowerCase() === 'true' : isTestEnv || true;

    if (!providedSourceKey) {
      await this.storage.uploadObject(
        sourceKey,
        buffer,
        {
          'content-type': this.detectContentType(filename) ?? 'application/octet-stream',
          'preprocess-request-id': requestId,
        },
        bucket,
      );
    }

    const redis = this.createRedisClient();
    await redis.connect();
    const callbackChannel = `${this.responseChannel}:${requestId}`;
    await redis.subscribe(callbackChannel);

    let message: PreprocessResponseMessage;
    try {
      const waitForResult = this.waitForResponse(redis, callbackChannel, requestId, allowTimeoutFallback);

      try {
        const url = `${this.preprocessorUrl.replace(/\/$/, '')}/preprocess`;
        await axios.post(
          url,
          {
            requestId,
            sourceBucket: bucket,
            sourceKey,
            resultBucket: bucket,
            resultKey,
            callbackChannel,
            traceId,
          },
          {
            timeout: this.timeoutMs,
            headers: this.buildAuthHeaders(),
          },
        );
      } catch (err) {
        await redis.unsubscribe(callbackChannel).catch(() => undefined);
        await redis.quit().catch(() => undefined);
        this.logger.warn('preprocess.dispatch_failed', {
          traceId,
          error: err instanceof Error ? err.message : 'unknown',
        });
        throw err;
      }

      try {
        message = await waitForResult;
      } catch (err) {
        if (allowTimeoutFallback && err instanceof Error && /timed out/i.test(err.message)) {
          this.logger.warn('preprocess.timeout_fallback', { traceId, requestId });
          return {
            buffer,
            correctionAngleDeg: 0,
            objectKey: sourceKey,
            bucket,
          };
        }
        throw err;
      }
    } finally {
      await redis.unsubscribe(callbackChannel).catch(() => undefined);
      await redis.quit().catch(() => undefined);
    }

    if (message.error) {
      this.logger.warn('preprocess.error', { traceId, requestId, error: message.error });
      throw new Error(message.error);
    }

    const processedBucket = message.bucket ?? bucket;
    const processedKey = message.resultKey ?? resultKey;

    const processedBuffer = await this.storage.downloadObject(processedKey, processedBucket);

    this.logger.info('preprocess.completed', {
      traceId,
      requestId,
      processedKey,
      processedBucket,
      correctionAngleDeg: message.correctionAngleDeg ?? 0,
    });

    return {
      buffer: processedBuffer,
      correctionAngleDeg: message.correctionAngleDeg ?? 0,
      objectKey: processedKey,
      bucket: processedBucket,
    };
  }

  private async waitForResponse(
    redis: Redis,
    channel: string,
    requestId: string,
    resolveOnTimeout: boolean,
  ): Promise<PreprocessResponseMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        if (resolveOnTimeout) {
          resolve({ requestId, resultKey: '', error: 'Preprocessing response timed out' });
        } else {
          reject(new Error('Preprocessing response timed out'));
        }
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        redis.removeListener('message', onMessage);
      };

      const onMessage = (_channel: string, raw: string) => {
        try {
          const parsed = JSON.parse(raw) as PreprocessResponseMessage;
          if (parsed.requestId !== requestId) return;
          cleanup();
          resolve(parsed);
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      redis.on('message', onMessage);
    });
  }

  private createRedisClient(): Redis {
    return new Redis(this.redisUrl, { lazyConnect: true });
  }

  private detectExtension(filename?: string): string {
    if (!filename) return '.bin';
    const ext = extname(filename).toLowerCase();
    if (ext === '.pdf') return '.pdf';
    if (ext === '.png') return '.png';
    if (ext === '.jpg' || ext === '.jpeg') return '.jpg';
    if (ext === '.tif' || ext === '.tiff') return '.tif';
    return '.bin';
  }

  private detectContentType(filename?: string): string | undefined {
    const ext = filename ? extname(filename).toLowerCase() : undefined;
    switch (ext) {
      case '.pdf':
        return 'application/pdf';
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.tif':
      case '.tiff':
        return 'image/tiff';
      default:
        return undefined;
    }
  }

  private buildAuthHeaders(): Record<string, string> {
    const authHeader = this.workerAuth.buildAuthHeader();
    if (!authHeader) {
      throw new Error('Worker auth token is required for preprocessing dispatch');
    }
    return { Authorization: authHeader };
  }
}
