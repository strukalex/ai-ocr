import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID, createHash } from 'crypto';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import request from 'supertest';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { PDFDocument } from 'pdf-lib';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { Client as MinioClient } from 'minio';

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
  let redisContainer: StartedTestContainer;
  let minioContainer: StartedTestContainer;
  let redisUrl: string;

  const closeBullmqResources = async () => {
    const resources = (
      global as unknown as {
        __BULLMQ_RESOURCES__?: {
          queues: Set<Queue>;
          workers: Set<Worker>;
          events: Set<QueueEvents>;
        };
      }
    ).__BULLMQ_RESOURCES__;
    if (!resources) return;
    const { queues, workers, events } = resources;
    const closers = [
      ...Array.from(queues ?? []).map((q) => q.close()),
      ...Array.from(workers ?? []).map((w) => w.close()),
      ...Array.from(events ?? []).map((e) => e.close()),
    ];
    await Promise.allSettled(closers);
  };

  beforeAll(async () => {
    // Start Redis + MinIO to ensure deterministic endpoints for Queue/Storage.
    redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();

    redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

    minioContainer = await new GenericContainer('minio/minio:latest')
      .withEnvironment({
        MINIO_ACCESS_KEY: 'minioadmin',
        MINIO_SECRET_KEY: 'minioadmin',
        MINIO_ADDRESS: ':9000',
      })
      .withCommand(['server', '/data'])
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    process.env['REDIS_URL'] = redisUrl;
    process.env['MINIO_ENDPOINT'] = minioContainer.getHost();
    process.env['MINIO_PORT'] = String(minioContainer.getMappedPort(9000));
    process.env['MINIO_USE_SSL'] = 'false';
    process.env['MINIO_ACCESS_KEY'] = 'minioadmin';
    process.env['MINIO_SECRET_KEY'] = 'minioadmin';
    process.env['MINIO_BUCKET'] = 'documents';
    process.env['MINIO_ENFORCE_SSE'] = 'false';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(QueueService)
      .useValue(new QueueService({ redisUrl }))
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
    await storage.ensureBucket(storage.getDefaultBucket());
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
    await prisma.auditEvent.deleteMany({});
    await intakeQueue?.obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await intakeQueue?.close().catch(() => undefined);
    await closeBullmqResources().catch(() => undefined);
    // Brief pause to let Redis connections drain before stopping container.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await app?.close();
    await minioContainer?.stop();
    await redisContainer?.stop();
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

  it('fails intake on checksum mismatch when not allowed', async () => {
    const pdf = await makeSamplePdfBuffer('checksum-mismatch');
    const declaredChecksum = 'abc-not-real';
    const filePath = path.join(tmpDir, `bad-${randomUUID()}.pdf`);
    await writeFile(filePath, pdf);

    const created = await prisma.document.create({
      data: {
        sourceChannel: SourceChannel.Upload,
        originalUri: `file://${filePath}`,
        canonicalUri: null,
        checksum: declaredChecksum,
        status: DocumentStatus.Uploaded,
      },
    });
    await prisma.intakeRequest.create({
      data: {
        documentId: created.id,
        intakeSourceId: null,
        idempotencyKey: 'checksum-mismatch',
        status: 'received',
      },
    });

    const job = await queueService.enqueue(
      intakeQueue,
      'intake',
      {
        documentId: created.id,
        checksum: declaredChecksum,
        originalUri: `file://${filePath}`,
        filename: path.basename(filePath),
        sourceChannel: SourceChannel.Upload,
        idempotencyKey: 'checksum-mismatch',
      },
      { jobId: 'checksum-mismatch' },
    );

    const processor = buildProcessor();
    await processor.handle(job as any);
    await job.remove();

    const updated = await prisma.document.findUnique({ where: { id: created.id } });
    expect(updated?.status).toBe(DocumentStatus.Failed);
    expect(updated?.stateReason).toBe('Checksum mismatch');
  });

  // SSE metadata enforcement requires MinIO KMS configuration; skipped in this harness.

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

  it('writes audit events for processed and failed intake paths', async () => {
    const pdf = await makeSamplePdfBuffer('audit-ok');
    const checksum = createHash('sha256').update(pdf).digest('hex');
    const filePath = path.join(tmpDir, `audit-${randomUUID()}.pdf`);
    await writeFile(filePath, pdf);

    const payload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${filePath}`,
      filename: path.basename(filePath),
      checksum,
      idempotencyKey: `idem-${checksum}-audit`,
      metadata: { rawContentBase64: pdf.toString('base64') },
    };

    const res = await request(app.getHttpServer()).post('/api/documents').send(payload).expect(201);
    const job = await intakeQueue.getJob(payload.idempotencyKey ?? payload.checksum);
    expect(job).toBeDefined();

    const processor = buildProcessor();
    await processor.handle(job as any);
    await job?.remove();

    const waitForAudit = async (documentId: string, action: string) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const rows = await prisma.auditEvent.findMany({ where: { documentId } });
        if (rows.some((a) => a.action === action)) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return false;
    };

    const processedAuditFound = await waitForAudit(res.body.documentId, 'ingestion.intake_processed');
    if (!processedAuditFound) {
      const audits = await prisma.auditEvent.findMany({ where: { documentId: res.body.documentId } });
      // eslint-disable-next-line no-console
      console.warn('Audit not observed yet for document', res.body.documentId, audits);
    }
    expect(processedAuditFound).toBe(true);

    await prisma.auditEvent.deleteMany({});

    const missingDoc = await prisma.document.create({
      data: {
        sourceChannel: SourceChannel.Upload,
        originalUri: 'file:///tmp/does-not-exist.pdf',
        canonicalUri: null,
        checksum: 'missing-audit',
        status: DocumentStatus.Uploaded,
      },
    });
    await prisma.intakeRequest.create({
      data: {
        documentId: missingDoc.id,
        intakeSourceId: null,
        idempotencyKey: 'audit-missing',
        status: 'received',
      },
    });

    const failJob = await queueService.enqueue(
      intakeQueue,
      'intake',
      {
        documentId: missingDoc.id,
        checksum: 'missing-audit',
        originalUri: 'file:///tmp/does-not-exist.pdf',
        filename: 'does-not-exist.pdf',
        sourceChannel: SourceChannel.Upload,
        idempotencyKey: 'audit-missing',
      },
      { jobId: 'audit-missing' },
    );

    await processor.handle(failJob as any);
    await failJob.remove();

    const failedAuditFound = await waitForAudit(missingDoc.id, 'ingestion.intake_failed');
    if (!failedAuditFound) {
      const audits = await prisma.auditEvent.findMany({ where: { documentId: missingDoc.id } });
      // eslint-disable-next-line no-console
      console.warn('Failed audit not observed yet for document', missingDoc.id, audits);
    }
    expect(failedAuditFound).toBe(true);
  });

  it('emits structured logs with trace and document identifiers during processing', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const pdf = await makeSamplePdfBuffer('logging');
    const checksum = createHash('sha256').update(pdf).digest('hex');
    const filePath = path.join(tmpDir, `logging-${randomUUID()}.pdf`);
    await writeFile(filePath, pdf);

    const payload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${filePath}`,
      filename: path.basename(filePath),
      checksum,
      idempotencyKey: `idem-${checksum}-log`,
      metadata: { rawContentBase64: pdf.toString('base64') },
    };

    const res = await request(app.getHttpServer()).post('/api/documents').send(payload).expect(201);
    const job = await intakeQueue.getJob(payload.idempotencyKey ?? payload.checksum);
    expect(job).toBeDefined();

    const processor = buildProcessor();
    await processor.handle(job as any);
    await job?.remove();

    const structured = consoleSpy.mock.calls
      .map((c) => c[0])
      .filter((entry) => typeof entry === 'string')
      .map((entry) => {
        try {
          return JSON.parse(entry as string);
        } catch {
          return null;
        }
      })
      .filter((parsed) => parsed && parsed.message === 'ingestion.intake_processed');

    expect(structured.length).toBeGreaterThanOrEqual(1);
    const log = structured[0];
    expect(log.documentId).toBe(res.body.documentId);
    expect(log.traceId).toBeDefined();

    consoleSpy.mockRestore();
  });
});

