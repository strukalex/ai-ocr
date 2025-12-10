import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../../apps/api/src/app/app.module';
import { PrismaService } from '@my-org/database';
import request from 'supertest';
import { QueueService, withDefaultJobOptions } from '@my-org/queue';
import { LoggerService } from '@my-org/observability';
import { JwtAuthGuard } from '../../../apps/api/src/app/auth/jwt-auth.guard';
import { AuthService } from '../../../apps/api/src/app/auth/auth.service';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { IntakeProcessor } from '../../../apps/workers/ingestion-worker/src/app/processors/intake.processor';
import { PreprocessingService } from '../../../apps/workers/ingestion-worker/src/app/services/preprocessing.service';
import { NormalizationService } from '../../../apps/workers/ingestion-worker/src/app/services/normalization.service';
import { StorageService } from '@my-org/storage';
import { AuditLogger } from '@my-org/observability';

process.env['DB_AT_REST_ENCRYPTED'] = 'true';

describe('Ingestion Pipeline (integration)', () => {
  let app: INestApplication;
  let tmpFilePath: string;

  const prismaMock = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    auditEvent: {
      create: jest.fn().mockResolvedValue(undefined),
    } as any,
    document: {
      create: jest.fn().mockResolvedValue({ id: 'doc-1', status: 'Uploaded' }),
      findFirst: jest.fn().mockResolvedValue(null),
    } as any,
    intakeRequest: {
      create: jest.fn().mockResolvedValue({ id: 'intake-1' }),
    } as any,
  } as unknown as PrismaService;
  const queueMock = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  };
  const queueServiceMock: Partial<QueueService> = {
    createQueue: jest.fn().mockReturnValue(queueMock as any),
    enqueue: jest.fn(async (queue: any, name: string, data: any, options?: any) =>
      queue.add(name, data, withDefaultJobOptions(options)),
    ),
  };
  const loggerMock: Partial<LoggerService> = {
    info: jest.fn(),
  };
  const auditMock: Partial<AuditLogger> = {
    log: jest.fn(),
  };
  loggerMock.warn = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(QueueService)
      .useValue(queueServiceMock)
      .overrideProvider(LoggerService)
      .useValue(loggerMock)
      .overrideProvider(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = { userId: 'test-user', roles: [] };
          return true;
        },
      })
      .overrideProvider(AuthService)
      .useValue({
        verify: jest.fn().mockResolvedValue({
          userId: 'test-user',
          roles: [],
        }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    const dir = await mkdtemp(join(tmpdir(), 'ingest-'));
    tmpFilePath = join(dir, 'sample.pdf');
    await writeFile(tmpFilePath, Buffer.from('test-payload'));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts document upload and enqueues intake job', async () => {
    const payload = {
      sourceChannel: 'upload',
      originalUri: `file://${tmpFilePath}`,
      filename: 'sample.pdf',
      checksum: 'sha256-sample',
      idempotencyKey: 'test-ingest-001',
      metadata: { submitter: 'integration-test' },
    };

    const response = await request(app.getHttpServer())
      .post('/api/documents')
      .send(payload)
      .expect(201);

    expect(response.headers['trace-id']).toBeDefined();
    expect(response.headers['traceparent']).toBeDefined();

    const traceIdFromHeaders = response.headers['trace-id'];
    expect(queueMock.add).toHaveBeenCalledWith(
      'intake',
      expect.objectContaining({
        documentId: 'doc-1',
        checksum: payload.checksum,
        originalUri: payload.originalUri,
        traceId: traceIdFromHeaders,
      }),
      expect.objectContaining({
        jobId: payload.idempotencyKey,
        attempts: expect.any(Number),
        backoff: expect.objectContaining({ type: 'exponential' }),
      }),
    );

    expect(loggerMock.info).toHaveBeenCalledWith(
      'ingestion.intake_enqueued',
      expect.objectContaining({
        documentId: 'doc-1',
        checksum: payload.checksum,
        idempotencyKey: payload.idempotencyKey,
        traceId: expect.any(String),
        user_id: 'test-user',
      }),
    );
  });

  it('dedupes by checksum and returns existing document without enqueue', async () => {
    prismaMock.document.findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'doc-1', status: 'Uploaded' });

    // first request seeds initial document
    await request(app.getHttpServer())
      .post('/api/documents')
      .send({
        sourceChannel: 'upload',
        originalUri: `file://${tmpFilePath}`,
        filename: 'sample.pdf',
        checksum: 'sha256-sample',
        idempotencyKey: 'dedupe-1',
      })
      .expect(201);

    queueMock.add.mockClear();

    const duplicateResponse = await request(app.getHttpServer())
      .post('/api/documents')
      .send({
        sourceChannel: 'upload',
        originalUri: 'file:///tmp/sample.pdf',
        filename: 'sample.pdf',
        checksum: 'sha256-sample',
        idempotencyKey: 'dedupe-1',
      })
      .expect(201);

    expect(duplicateResponse.body.documentId).toBe('doc-1');
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  describe('IntakeProcessor failure handling', () => {
    const storageMock = {
      getDefaultBucket: jest.fn().mockReturnValue('documents'),
      objectExists: jest.fn(),
      uploadObject: jest.fn(),
      downloadObject: jest.fn(),
    } as unknown as jest.Mocked<StorageService>;

    const preprocessingMock = {
      preprocess: jest.fn(),
    } as unknown as jest.Mocked<PreprocessingService>;

    const normalizationMock = {
      toPdfA: jest.fn(),
    } as unknown as jest.Mocked<NormalizationService>;

    const queueService = {
      createQueue: jest.fn().mockReturnValue({} as any),
      enqueue: jest.fn(),
    } as unknown as QueueService;

    const basePayload = {
      documentId: 'doc-123',
      checksum: 'declared-checksum',
      originalUri: undefined,
      filename: 'missing.pdf',
      idempotencyKey: 'idem-1',
      sourceChannel: 'upload',
    };

    beforeEach(() => {
      jest.resetAllMocks();
      prismaMock.document.findUnique = jest.fn().mockResolvedValue({
        id: basePayload.documentId,
        originalUri: null,
      });
      prismaMock.document.update = jest.fn().mockResolvedValue({});
      auditMock.log = jest.fn().mockResolvedValue(undefined);
    });

    it('marks document Failed when original content is unavailable', async () => {
      const processor = new IntakeProcessor(
        prismaMock as any,
        auditMock as any,
        loggerMock as any,
        storageMock,
        preprocessingMock,
        normalizationMock,
        queueService,
      );

      await processor.handle({
        data: {
          ...basePayload,
          originalUri: undefined,
        },
      } as any);

      expect(prismaMock.document.update).toHaveBeenCalledWith({
        where: { id: basePayload.documentId },
        data: {
          status: 'Failed',
          stateReason: 'Original content unavailable',
        },
      });
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ingestion.intake_failed',
          metadata: expect.objectContaining({ reason: 'missing_original' }),
        }),
      );
      expect(preprocessingMock.preprocess).not.toHaveBeenCalled();
      expect(normalizationMock.toPdfA).not.toHaveBeenCalled();
    });

    it('marks document Failed on checksum mismatch when not allowed', async () => {
      const processor = new IntakeProcessor(
        prismaMock as any,
        auditMock as any,
        loggerMock as any,
        storageMock,
        preprocessingMock,
        normalizationMock,
        queueService,
      );

      await processor.handle({
        data: {
          ...basePayload,
          originalUri: 's3://documents/originals/other',
          metadata: {
            rawContentBase64: Buffer.from('different-content').toString('base64'),
          },
          checksum: 'declared-checksum',
        },
      } as any);

      expect(prismaMock.document.update).toHaveBeenCalledWith({
        where: { id: basePayload.documentId },
        data: {
          status: 'Failed',
          stateReason: 'Checksum mismatch',
        },
      });
      expect(auditMock.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ingestion.intake_failed',
          metadata: expect.objectContaining({ reason: 'checksum_mismatch' }),
        }),
      );
      expect(preprocessingMock.preprocess).not.toHaveBeenCalled();
      expect(normalizationMock.toPdfA).not.toHaveBeenCalled();
    });
  });
});
