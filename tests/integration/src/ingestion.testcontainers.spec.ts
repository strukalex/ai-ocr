import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID, createHash } from 'crypto';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import request from 'supertest';
import { Queue } from 'bullmq';
import { PDFDocument } from 'pdf-lib';

import { AppModule } from '../../../apps/api/src/app/app.module';
import { JwtAuthGuard } from '../../../apps/api/src/app/auth/jwt-auth.guard';
import { AuthService } from '../../../apps/api/src/app/auth/auth.service';
import { PrismaService } from '@my-org/database';
import { QueueService } from '@my-org/queue';
import { StorageService, StorageModuleOptions } from '@my-org/storage';
import { AuditLogger, LoggerService } from '@my-org/observability';
import { IntakeProcessor } from '../../../apps/workers/ingestion-worker/src/app/processors/intake.processor';
import { NormalizationService } from '../../../apps/workers/ingestion-worker/src/app/services/normalization.service';
import { PreprocessingService } from '../../../apps/workers/ingestion-worker/src/app/services/preprocessing.service';
import { DocumentStatus, SourceChannel } from '@my-org/shared-types';

class StubWorkerAuthService {
  buildAuthHeader(): string | null {
    return null;
  }
}

async function makeSamplePdfBuffer(label = 'hello'): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 300]);
  page.drawText(`sample-${label}`);
  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

describe('Ingestion (testcontainers)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let queueService: QueueService;
  let logger: LoggerService;
  let audit: AuditLogger;
  let intakeQueue: Queue;
  let tmpDir: string;
  let storageOptions: StorageModuleOptions;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
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

    storageOptions = {
      endPoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
      port: process.env['MINIO_PORT'] ? Number(process.env['MINIO_PORT']) : 9000,
      useSSL: (process.env['MINIO_USE_SSL'] ?? 'false').toLowerCase() === 'true',
      accessKey: process.env['MINIO_ACCESS_KEY'] ?? 'minioadmin',
      secretKey: process.env['MINIO_SECRET_KEY'] ?? 'minioadmin',
      defaultBucket: process.env['MINIO_BUCKET'] ?? 'documents',
      sseAlgorithm: 'AES256',
      enforceSse: false,
    };

    prisma = app.get(PrismaService);
    queueService = app.get(QueueService);
    logger = app.get(LoggerService);
    audit = app.get(AuditLogger);
    storage = new StorageService(storageOptions);
    const originalEnqueue = queueService.enqueue.bind(queueService);
    queueService.enqueue = (async (
      queue: Queue,
      name: string,
      data: unknown,
      options?: any,
    ) => {
      const safeOptions = { ...options };
      if (safeOptions?.jobId?.includes(':')) {
        safeOptions.jobId = safeOptions.jobId.replace(/:/g, '-');
      }
      return originalEnqueue(queue, name, data, safeOptions);
    }) as any;
    intakeQueue = queueService.createQueue('intake');
    tmpDir = await mkdtemp(path.join(tmpdir(), 'ingest-int-'));
  });

  afterEach(async () => {
    await prisma.intakeRequest.deleteMany({});
    await prisma.document.deleteMany({});
    await intakeQueue?.obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await intakeQueue?.close().catch(() => undefined);
    await app?.close();
  });

  const buildProcessor = () => {
    const normalization = new NormalizationService(logger);
    const preprocessing = new PreprocessingService(logger, storage, new StubWorkerAuthService() as any);
    return new IntakeProcessor(prisma, audit, logger, storage, preprocessing, normalization, queueService);
  };

  it('stores original/canonical artifacts and enqueues intake job', async () => {
    const pdf = await makeSamplePdfBuffer('happy');
    const checksum = createHash('sha256').update(pdf).digest('hex');
    const filePath = path.join(tmpDir, `sample-${randomUUID()}.pdf`);
    await writeFile(filePath, pdf);

    const payload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${filePath}`,
      filename: path.basename(filePath),
      checksum,
      idempotencyKey: `idem-${checksum}`,
      metadata: { rawContentBase64: pdf.toString('base64') },
    };

    const res = await request(app.getHttpServer()).post('/api/documents').send(payload).expect(201);
    expect(res.body.documentId).toBeDefined();

    const job = await intakeQueue.getJob(payload.idempotencyKey ?? payload.checksum);
    expect(job).toBeDefined();

    const processor = buildProcessor();
    await processor.handle(job as any);
    await job?.remove();

    const bucket = storage.getDefaultBucket();
    expect(await storage.objectExists(`originals/${checksum}`, bucket)).toBe(true);
    expect(await storage.objectExists(`canonical/${checksum}.pdfa`, bucket)).toBe(true);

    const doc = await prisma.document.findUnique({ where: { id: res.body.documentId } });
    expect(doc?.status).toBe(DocumentStatus.Uploaded);
    expect(doc?.canonicalUri).toContain(`/canonical/${checksum}.pdfa`);
  });

  it('dedupes by checksum and avoids enqueueing a second job', async () => {
    const pdf = await makeSamplePdfBuffer('dedupe');
    const checksum = createHash('sha256').update(pdf).digest('hex');
    const filePath = path.join(tmpDir, `dedupe-${randomUUID()}.pdf`);
    await writeFile(filePath, pdf);

    const firstPayload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${filePath}`,
      filename: path.basename(filePath),
      checksum,
      idempotencyKey: `idem-${checksum}`,
      metadata: { rawContentBase64: pdf.toString('base64') },
    };

    const first = await request(app.getHttpServer()).post('/api/documents').send(firstPayload).expect(201);
    const firstJob = await intakeQueue.getJob(firstPayload.idempotencyKey ?? checksum);
    expect(firstJob).toBeDefined();

    // Process the first job to simulate normal flow.
    const processor = buildProcessor();
    await processor.handle(firstJob as any);
    await firstJob?.remove();

    const secondPayload = {
      ...firstPayload,
      idempotencyKey: `idem-${checksum}-second`,
    };
    const second = await request(app.getHttpServer()).post('/api/documents').send(secondPayload).expect(201);

    expect(second.body.documentId).toBe(first.body.documentId);
    const duplicateJob = await intakeQueue.getJob(secondPayload.idempotencyKey);
    expect(duplicateJob).toBeFalsy();
  });

  it('marks document Failed when original content is unavailable', async () => {
    const doc = await prisma.document.create({
      data: {
        sourceChannel: SourceChannel.Upload,
        originalUri: 'file:///tmp/does-not-exist.pdf',
        canonicalUri: null,
        checksum: 'missing-checksum',
        status: DocumentStatus.Uploaded,
      },
    });
    await prisma.intakeRequest.create({
      data: {
        documentId: doc.id,
        intakeSourceId: null,
        idempotencyKey: 'missing-original',
        status: 'received',
      },
    });

    const job = await queueService.enqueue(
      intakeQueue,
      'intake',
      {
        documentId: doc.id,
        checksum: 'missing-checksum',
        originalUri: 'file:///tmp/does-not-exist.pdf',
        filename: 'does-not-exist.pdf',
        sourceChannel: SourceChannel.Upload,
        idempotencyKey: 'missing-original',
      },
      { jobId: 'missing-original' },
    );

    const processor = buildProcessor();
    await processor.handle(job as any);
    await job.remove();

    const updated = await prisma.document.findUnique({ where: { id: doc.id } });
    expect(updated?.status).toBe(DocumentStatus.Failed);
    expect(updated?.stateReason).toBe('Original content unavailable');
  });
});

