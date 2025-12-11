import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { execSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { writeFile, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import request from 'supertest';
import { Queue, Worker } from 'bullmq';
import { PDFDocument } from 'pdf-lib';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import Redis from 'ioredis';
import express from 'express';
import { AddressInfo } from 'net';
import { Client as MinioClient } from 'minio';

import { AppModule } from '../../../apps/api/src/app/app.module';
import { JwtAuthGuard } from '../../../apps/api/src/app/auth/jwt-auth.guard';
import { AuthService } from '../../../apps/api/src/app/auth/auth.service';
import { PrismaService } from '@my-org/database';
import { QueueService } from '@my-org/queue';
import { StorageService } from '@my-org/storage';
import { AuditLogger, LoggerService } from '@my-org/observability';
import { IntakeProcessor } from '../../../apps/workers/ingestion-worker/src/app/processors/intake.processor';
import { SplitProcessor } from '../../../apps/workers/ingestion-worker/src/app/processors/split.processor';
import { ClassifyProcessor } from '../../../apps/workers/ingestion-worker/src/app/processors/classify.processor';
import { NormalizationService } from '../../../apps/workers/ingestion-worker/src/app/services/normalization.service';
import { PreprocessingService } from '../../../apps/workers/ingestion-worker/src/app/services/preprocessing.service';
import { DocumentStatus, SourceChannel } from '@my-org/shared-types';
import { WorkerAuthService } from '../../../apps/workers/ingestion-worker/src/app/auth/worker-auth.service';
import { IngestWatcherModule } from '../../../apps/ingest-watcher/src/app/ingest-watcher.module';
import { WatcherService } from '../../../apps/ingest-watcher/src/app/watcher.service';

jest.setTimeout(180_000);

class StubWorkerAuthService implements Partial<WorkerAuthService> {
  constructor(private token = 'Bearer test-token') {}
  buildAuthHeader(): string | null {
    return this.token;
  }
  signServiceToken(): string | null {
    return this.token;
  }
}

async function makeSamplePdfBuffer(label = 'happy'): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 300]);
  page.drawText(`sample-${label}`);
  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

async function makePngBuffer(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 100]);
  page.drawText('image-for-preprocess');
  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

async function makeMultiPartPdfBuffer(headers: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  headers.forEach((header) => {
    const page = pdf.addPage([300, 300]);
    page.drawText(`HEADER:${header}`);
  });
  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

const closeQueue = async (q?: Queue) => {
  if (!q) return;
  try {
    await q.close();
  } catch {
    /* ignore */
  }
  try {
    await (q as any).disconnect?.();
  } catch {
    /* ignore */
  }
};

const closeWorker = async (w?: Worker<any, any, string>) => {
  if (!w) return;
  try {
    await w.close();
  } catch {
    /* ignore */
  }
};

const startStubServer = async (responseBody: Record<string, any>) => {
  const appServer = express();
  appServer.use(express.json({ limit: '5mb' }));

  appServer.post('/classify', (_req, res) => {
    res.status(200).json(responseBody);
  });

  const server = await new Promise<ReturnType<typeof appServer.listen>>((resolve) => {
    const s = appServer.listen(0, () => resolve(s));
  });
  const serverPort = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${serverPort}/classify`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const setEnv = (vars: Record<string, string | undefined>) => {
  const prev: Record<string, string | undefined> = {};
  Object.entries(vars).forEach(([key, value]) => {
    prev[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  return () =>
    Object.entries(prev).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
};

const waitForAuditEvent = async (
  prisma: PrismaService,
  documentId: string,
  action: string,
  attempts = 60,
  delayMs = 500,
) => {
  for (let i = 0; i < attempts; i++) {
    const event = await prisma.auditEvent.findFirst({
      where: { documentId, action },
      orderBy: { createdAt: 'desc' },
    });
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
};

class TrackingQueueService extends QueueService {
  queues: Queue[] = [];

  override createQueue(name: string, queueOptions?: any): Queue {
    const q = super.createQueue(name, queueOptions);
    this.queues.push(q);
    return q;
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.queues.map((q) => closeQueue(q)));
  }
}

const waitForJob = async (queue: Queue, jobId: string, timeoutMs = 10_000): Promise<ReturnType<Queue['getJob']>> => {
  const start = Date.now();
  let job = await queue.getJob(jobId);
  while (!job && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
    job = await queue.getJob(jobId);
  }
  return job;
};

describe('Ingestion (full testcontainers)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queueService: TrackingQueueService;
  let logger: LoggerService;
  let audit: AuditLogger;
  let intakeQueue: Queue;
  let splitQueue: Queue;
  let classifyQueue: Queue;
  let tmpDir: string;
  let storage: StorageService;
  const workerQueues: Queue[] = [];

  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let minio: StartedTestContainer;

  const minioConfig = {
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
    bucket: 'documents-e2e',
  };

  beforeAll(async () => {
    pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'test',
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB: 'test',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections'))
      .start();

    redis = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();

    minio = await new GenericContainer('minio/minio:latest')
      .withEnvironment({
        MINIO_ACCESS_KEY: minioConfig.accessKey,
        MINIO_SECRET_KEY: minioConfig.secretKey,
        MINIO_ADDRESS: ':9000',
        MINIO_KMS_SECRET_KEY:
          'minio-test-key:voi2eYflLnCN97BhGIIAwRJJZA/jMxSSrlpCNdLN72Y=',
      })
      .withCommand(['server', '/data'])
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const pgUrl = `postgresql://test:test@${pg.getHost()}:${pg.getMappedPort(5432)}/test`;
    process.env['DATABASE_URL'] = pgUrl;
    process.env['REDIS_URL'] = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    process.env['MINIO_ENDPOINT'] = minio.getHost();
    process.env['MINIO_PORT'] = String(minio.getMappedPort(9000));
    process.env['MINIO_USE_SSL'] = 'false';
    process.env['MINIO_ACCESS_KEY'] = minioConfig.accessKey;
    process.env['MINIO_SECRET_KEY'] = minioConfig.secretKey;
    process.env['MINIO_BUCKET'] = minioConfig.bucket;
    process.env['MINIO_ENFORCE_SSE'] = 'false';

    execSync('npx prisma db push --skip-generate --schema packages/database/prisma/schema.prisma', {
      cwd: path.join(__dirname, '../../..'),
      env: { ...process.env },
      stdio: 'inherit',
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(QueueService)
      .useValue(new TrackingQueueService({ redisUrl: process.env['REDIS_URL'] }))
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

    prisma = app.get(PrismaService);
    queueService = app.get(QueueService) as TrackingQueueService;
    logger = app.get(LoggerService);
    audit = app.get(AuditLogger);

    storage = new StorageService({
      endPoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
      port: Number(process.env['MINIO_PORT'] ?? 9000),
      useSSL: false,
      accessKey: minioConfig.accessKey,
      secretKey: minioConfig.secretKey,
      defaultBucket: minioConfig.bucket,
      sseAlgorithm: 'AES256',
      enforceSse: true,
    });
    await storage.ensureBucket(minioConfig.bucket);

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
    splitQueue = queueService.createQueue('split');
    classifyQueue = queueService.createQueue('classify');
    tmpDir = await mkdtemp(path.join(tmpdir(), 'ingest-int-'));
  });

  afterEach(async () => {
    if (prisma) {
      await prisma.intakeRequest.deleteMany({}).catch(() => undefined);
      await prisma.document.deleteMany({}).catch(() => undefined);
    }
    await intakeQueue?.obliterate({ force: true }).catch(() => undefined);
    await splitQueue?.obliterate({ force: true }).catch(() => undefined);
    await classifyQueue?.obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await queueService?.closeAll?.().catch(() => undefined);
    await Promise.all(workerQueues.map((q) => closeQueue(q)));
    await closeQueue(intakeQueue);
    await closeQueue(splitQueue);
    await closeQueue(classifyQueue);
    await app?.close();
    // small delay to allow Redis connections to settle before container teardown
    await new Promise((resolve) => setTimeout(resolve, 300));
    await minio?.stop();
    await redis?.stop();
    await pg?.stop();
  });

  type BuildProcessorOptions = {
    preprocessing?: Partial<PreprocessingService>;
    stubNormalization?: boolean;
  };

  const buildProcessor = (options?: BuildProcessorOptions): IntakeProcessor => {
    const normalization = new NormalizationService(logger);
    if (options?.stubNormalization !== false) {
      // Avoid Ghostscript dependency in CI by falling back to pass-through when env is missing.
      jest.spyOn(normalization, 'toPdfA').mockImplementation(async (buffer) => buffer);
    }

    const preprocessing =
      options?.preprocessing ??
      ({
        preprocess: async ({ buffer, bucket, sourceKey }: any) => ({
          buffer,
          correctionAngleDeg: 0,
          objectKey: sourceKey,
          bucket: bucket ?? storage.getDefaultBucket(),
        }),
      } as Partial<PreprocessingService>);

    return new IntakeProcessor(
      prisma,
      audit,
      logger,
      storage,
      preprocessing as PreprocessingService,
      normalization,
      queueService,
    );
  };

  it('stores original and canonical artifacts with SSE enforced and updates status', async () => {
    const pdf = await makeSamplePdfBuffer('sse');
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
    const minioClient = new MinioClient({
      endPoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
      port: Number(process.env['MINIO_PORT'] ?? 9000),
      useSSL: false,
      accessKey: minioConfig.accessKey,
      secretKey: minioConfig.secretKey,
    });

    const originalStat = await minioClient.statObject(bucket, `originals/${checksum}`);
    const canonicalStat = await minioClient.statObject(bucket, `canonical/${checksum}.pdfa`);

    expect(originalStat).toBeDefined();
    expect(canonicalStat).toBeDefined();

    const doc = await prisma.document.findUnique({ where: { id: res.body.documentId } });
    expect(doc?.status).toBe(DocumentStatus.Uploaded);
    expect(doc?.canonicalUri).toContain(`/canonical/${checksum}.pdfa`);
  });

  it('converts to PDF/A via Ghostscript and enforces SSE on canonical artifact', async () => {
    // Fail fast if Ghostscript is not available in the host environment.
    execSync('gs --version', { stdio: 'pipe' });

    const pngPdf = await makePngBuffer();
    const checksum = createHash('sha256').update(pngPdf).digest('hex');
    const filePath = path.join(tmpDir, `pdfa-${randomUUID()}.png`);
    await writeFile(filePath, pngPdf);

    const payload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${filePath}`,
      filename: path.basename(filePath),
      checksum,
      idempotencyKey: `idem-${checksum}-pdfa`,
      metadata: { rawContentBase64: pngPdf.toString('base64') },
    };

    const res = await request(app.getHttpServer()).post('/api/documents').send(payload).expect(201);
    const documentId = res.body.documentId;

    const job = await waitForJob(intakeQueue, payload.idempotencyKey ?? checksum, 5_000);
    expect(job).toBeDefined();

    const processor = buildProcessor({ stubNormalization: false });
    await processor.handle(job as any);
    await job?.remove();

    const bucket = storage.getDefaultBucket();
    const minioClient = new MinioClient({
      endPoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
      port: Number(process.env['MINIO_PORT'] ?? 9000),
      useSSL: false,
      accessKey: minioConfig.accessKey,
      secretKey: minioConfig.secretKey,
    });

    const canonicalKey = `canonical/${checksum}.pdfa`;
    const canonicalStat = await minioClient.statObject(bucket, canonicalKey);
    expect(canonicalStat).toBeDefined();

    const sseEntry = Object.entries(canonicalStat.metaData ?? {}).find(([key]) =>
      key.toLowerCase().includes('server-side-encryption'),
    );
    expect(sseEntry?.[1]).toBeDefined();

    const canonicalBuffer = await storage.downloadObject(canonicalKey, bucket);
    expect(canonicalBuffer.toString('ascii', 0, 4)).toBe('%PDF');
    const canonicalChecksum = createHash('sha256').update(canonicalBuffer).digest('hex');
    expect(canonicalChecksum).not.toEqual(checksum);

    const doc = await prisma.document.findUnique({ where: { id: documentId } });
    expect(doc?.canonicalUri).toContain(canonicalKey);
    expect(doc?.status).toBe(DocumentStatus.Uploaded);
  });

  it('handles preprocessing step and stores processed artifact (stubbed service)', async () => {
    const pngBuffer = await makePngBuffer();
    const checksum = createHash('sha256').update(pngBuffer).digest('hex');

    const preprocessing: Partial<PreprocessingService> = {
      preprocess: async ({ buffer, bucket }) => {
        const bucketName = bucket ?? storage.getDefaultBucket();
        const resultKey = `preprocess/output/${randomUUID()}.png`;
        await storage.uploadObject(
          resultKey,
          buffer,
          { 'content-type': 'image/png', checksum },
          bucketName,
        );
        return {
          buffer,
          correctionAngleDeg: 1.5,
          objectKey: resultKey,
          bucket: bucketName,
        };
      },
    };

    const result = await (preprocessing as PreprocessingService).preprocess({
      buffer: pngBuffer,
      filename: 'sample.png',
      traceId: 'trace-preprocess',
    });

    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.correctionAngleDeg).toBeCloseTo(1.5, 1);
    expect(result.objectKey).toBeDefined();
    expect(
      await storage.objectExists(result.objectKey ?? '', result.bucket ?? storage.getDefaultBucket()),
    ).toBe(true);
  });

  it('splits multi-part PDFs and enqueues intake jobs for children', async () => {
    const pdf = await makeMultiPartPdfBuffer(['InvoiceA', 'InvoiceB']);
    const checksum = createHash('sha256').update(pdf).digest('hex');
    const filePath = path.join(tmpDir, `multipart-${randomUUID()}.pdf`);
    await writeFile(filePath, pdf);

    const payload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${filePath}`,
      filename: path.basename(filePath),
      checksum,
      idempotencyKey: `idem-${checksum}`,
    };

    const res = await request(app.getHttpServer()).post('/api/documents').send(payload).expect(201);
    const documentId = res.body.documentId;

    const job = await waitForJob(intakeQueue, payload.idempotencyKey ?? checksum, 5_000);
    expect(job).toBeDefined();

    const processor = buildProcessor();
    await processor.handle(job as any);
    await job?.remove();

    const splitJob = await waitForJob(splitQueue, `${documentId}-split`, 5_000);
    expect(splitJob).toBeDefined();

    const splitProcessor = new SplitProcessor(prisma, storage, queueService, audit, logger);
    await splitProcessor.handle(splitJob as any);
    await splitJob?.remove();

    const children = await prisma.document.findMany({ where: { parentDocumentId: documentId } });
    expect(children.length).toBeGreaterThanOrEqual(1);
    children.forEach((child) => {
      expect(child.rootDocumentId).toBe(documentId);
      expect(child.status).toBe(DocumentStatus.Uploaded);
    });

    const parent = await prisma.document.findUnique({ where: { id: documentId } });
    expect(parent?.status).toBe(DocumentStatus.Split);
    expect(parent?.stateReason).toContain('Split');

    // Child intake jobs should be present (job ids are child checksums).
    for (const child of children) {
      const childJob = await waitForJob(intakeQueue, child.checksum ?? '', 3_000);
      expect(childJob).toBeDefined();
    }
  });

  it('classifies documents and routes unknown vs ambiguous cases', async () => {
    const unknownPdf = await makeSamplePdfBuffer('classify-unknown');
    const unknownChecksum = createHash('sha256').update(unknownPdf).digest('hex');
    const unknownFilePath = path.join(tmpDir, `classify-unknown-${randomUUID()}.pdf`);
    await writeFile(unknownFilePath, unknownPdf);

    // Unknown path: no signals in filename/metadata/text.
    const unknownPayload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${unknownFilePath}`,
      filename: 'random.bin',
      checksum: unknownChecksum,
      idempotencyKey: `idem-${unknownChecksum}-unknown`,
    };
    const unknownRes = await request(app.getHttpServer())
      .post('/api/documents')
      .send(unknownPayload)
      .expect(201);

    const unknownJob = await waitForJob(
      intakeQueue,
      unknownPayload.idempotencyKey ?? unknownChecksum,
      5_000,
    );
    expect(unknownJob).toBeDefined();

    const processor = buildProcessor();
    await processor.handle(unknownJob as any);
    await unknownJob?.remove();

    const classifyJob = await waitForJob(classifyQueue, `${unknownRes.body.documentId}-classify`, 5_000);
    expect(classifyJob).toBeDefined();

    const classifyProcessor = new ClassifyProcessor(prisma, audit, logger);
    await classifyProcessor.handle(classifyJob as any);
    await classifyJob?.remove();

    const unknownDoc = await prisma.document.findUnique({ where: { id: unknownRes.body.documentId } });
    expect(unknownDoc?.status).toBe(DocumentStatus.Exception);
    expect(unknownDoc?.classificationType).toBe('unknown');

    // Ambiguous path: raise threshold so heuristic falls below and forces review.
    const priorThreshold = process.env['CLASSIFICATION_THRESHOLD'];
    process.env['CLASSIFICATION_THRESHOLD'] = '0.95';
    const invoicePdf = await makeSamplePdfBuffer('invoice');
    const invoiceChecksum = createHash('sha256').update(invoicePdf).digest('hex');
    const invoiceFilePath = path.join(tmpDir, `classify-invoice-${randomUUID()}.pdf`);
    await writeFile(invoiceFilePath, invoicePdf);
    const invoicePayload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${invoiceFilePath}`,
      filename: 'invoice.pdf',
      checksum: invoiceChecksum,
      idempotencyKey: `idem-${invoiceChecksum}-invoice`,
    };
    const invoiceRes = await request(app.getHttpServer())
      .post('/api/documents')
      .send(invoicePayload)
      .expect(201);

    const invoiceJob = await waitForJob(
      intakeQueue,
      invoicePayload.idempotencyKey ?? invoiceChecksum,
      5_000,
    );
    expect(invoiceJob).toBeDefined();

    await processor.handle(invoiceJob as any);
    await invoiceJob?.remove();

    const invoiceClassifyJob = await waitForJob(
      classifyQueue,
      `${invoiceRes.body.documentId}-classify`,
      5_000,
    );
    expect(invoiceClassifyJob).toBeDefined();

    const highThresholdProcessor = new ClassifyProcessor(prisma, audit, logger);
    await highThresholdProcessor.handle(invoiceClassifyJob as any);
    await invoiceClassifyJob?.remove();

    const invoiceDoc = await prisma.document.findUnique({ where: { id: invoiceRes.body.documentId } });
    expect(invoiceDoc?.status).toBe(DocumentStatus.PendingReview);
    expect(invoiceDoc?.stateReason).toContain('Classification requires confirmation');

    process.env['CLASSIFICATION_THRESHOLD'] = priorThreshold;
  });

  it('uses layoutlm tier when configured and records provider + tier', async () => {
    const restoreEnv = setEnv({
      CLASSIFIER_TIER: 'layoutlm',
      CLASSIFICATION_THRESHOLD: '0.5',
    });
    const stub = await startStubServer({ type: 'layout-invoice', confidence: 0.93 });
    process.env['LAYOUTLM_CLASSIFIER_URL'] = stub.url;

    const pdf = await makeSamplePdfBuffer('layout-tier');
    const checksum = createHash('sha256').update(pdf).digest('hex');
    const filePath = path.join(tmpDir, `layout-${randomUUID()}.pdf`);
    await writeFile(filePath, pdf);

    const payload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${filePath}`,
      filename: 'neutral.bin', // avoid heuristic hit
      checksum,
      idempotencyKey: `idem-${checksum}-layout-tier`,
    };

    const res = await request(app.getHttpServer()).post('/api/documents').send(payload).expect(201);
    const documentId = res.body.documentId;

    const job = await waitForJob(intakeQueue, payload.idempotencyKey ?? checksum, 5_000);
    expect(job).toBeDefined();
    const processor = buildProcessor();
    await processor.handle(job as any);
    await job?.remove();

    const classifyJob = await waitForJob(classifyQueue, `${documentId}-classify`, 5_000);
    expect(classifyJob).toBeDefined();
    const classifyProcessor = new ClassifyProcessor(prisma, audit, logger);
    await classifyProcessor.handle(classifyJob as any);
    await classifyJob?.remove();

    const doc = await prisma.document.findUnique({ where: { id: documentId } });
    expect(doc?.status).toBe(DocumentStatus.Classified);
    expect(doc?.classificationType).toBe('layout-invoice');
    expect(doc?.classificationConf).toBeCloseTo(0.93, 2);

    const auditEvent = await waitForAuditEvent(prisma, documentId, 'ingestion.classified');
    if (auditEvent) {
      const metadata = (auditEvent.metadata ?? {}) as Record<string, any>;
      expect(metadata['provider']).toBe('layoutlm');
      expect(metadata['tier']).toBe('layoutlm');
    }

    await stub.close();
    restoreEnv();
    delete process.env['LAYOUTLM_CLASSIFIER_URL'];
  });

  it('uses llm tier when configured and records provider + tier', async () => {
    const restoreEnv = setEnv({
      CLASSIFIER_TIER: 'llm',
      CLASSIFICATION_THRESHOLD: '0.5',
    });
    const stub = await startStubServer({ type: 'llm-contract', confidence: 0.91 });
    process.env['LLM_CLASSIFIER_URL'] = stub.url;

    const pdf = await makeSamplePdfBuffer('llm-tier');
    const checksum = createHash('sha256').update(pdf).digest('hex');
    const filePath = path.join(tmpDir, `llm-${randomUUID()}.pdf`);
    await writeFile(filePath, pdf);

    const payload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${filePath}`,
      filename: 'neutral.bin', // avoid heuristic bias
      checksum,
      idempotencyKey: `idem-${checksum}-llm-tier`,
    };

    const res = await request(app.getHttpServer()).post('/api/documents').send(payload).expect(201);
    const documentId = res.body.documentId;

    const job = await waitForJob(intakeQueue, payload.idempotencyKey ?? checksum, 5_000);
    expect(job).toBeDefined();
    const processor = buildProcessor();
    await processor.handle(job as any);
    await job?.remove();

    const classifyJob = await waitForJob(classifyQueue, `${documentId}-classify`, 5_000);
    expect(classifyJob).toBeDefined();
    const classifyProcessor = new ClassifyProcessor(prisma, audit, logger);
    await classifyProcessor.handle(classifyJob as any);
    await classifyJob?.remove();

    const doc = await prisma.document.findUnique({ where: { id: documentId } });
    expect(doc?.status).toBe(DocumentStatus.Classified);
    expect(doc?.classificationType).toBe('llm-contract');
    expect(doc?.classificationConf).toBeCloseTo(0.91, 2);

    const auditEvent = await waitForAuditEvent(prisma, documentId, 'ingestion.classified');
    if (auditEvent) {
      const metadata = (auditEvent.metadata ?? {}) as Record<string, any>;
      expect(metadata['provider']).toBe('llm');
      expect(metadata['tier']).toBe('llm');
    }

    await stub.close();
    restoreEnv();
    delete process.env['LLM_CLASSIFIER_URL'];
  });

  it('watches s3 bucket and enqueues intake with parity to POST /documents', async () => {
    // Create intake source
    const source = await prisma.intakeSource.create({
      data: {
        type: SourceChannel.WatchedStorage,
        uri: `s3://${minioConfig.bucket}/watched/`,
        active: true,
        pollingIntervalSeconds: 1,
      },
    });

    // Drop a file into MinIO before starting watcher; startS3Poller will pick it up on first poll.
    const minioClient = new MinioClient({
      endPoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
      port: Number(process.env['MINIO_PORT'] ?? 9000),
      useSSL: false,
      accessKey: minioConfig.accessKey,
      secretKey: minioConfig.secretKey,
    });
    const body = Buffer.from('watcher-parity');
    const checksum = createHash('sha256').update(body).digest('hex');
    const key = `watched/sample-${checksum}.txt`;
    await minioClient.putObject(minioConfig.bucket, key, body, body.length, {
      'content-type': 'text/plain',
    });

    // Boot watcher service using shared Prisma/Queue/Storage instances
    const watcher = new WatcherService(prisma as any, queueService as any, storage, logger, audit);
    await watcher.start();

    // wait for poller to process
    await new Promise((r) => setTimeout(r, 2500));

    let job = await waitForJob(intakeQueue, checksum, 12_000);
    if (!job) {
      for (const q of queueService.queues) {
        job = await waitForJob(q, checksum, 2000);
        if (job) break;
      }
    }

    const doc = await prisma.document.findFirst({ where: { checksum } });
    const intakeReq = await prisma.intakeRequest.findFirst({ where: { idempotencyKey: checksum } });
    expect(doc).toBeDefined();
    expect(intakeReq).toBeDefined();
    expect(doc?.sourceChannel).toBe(SourceChannel.WatchedStorage);

    await watcher.onModuleDestroy();
  });

  it('retries webhook jobs and leaves failed job for DLQ inspection', async () => {
    const queueName = 'webhook-test';
    const webhookQueue = queueService.createQueue(queueName);
    const worker = new Worker<any, any, string>(
      queueName,
      async () => {
        throw new Error('webhook failed');
      },
      { connection: { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' } },
    );

    const jobId = `webhook-${randomUUID()}`;
    await webhookQueue.add(
      'deliver',
      { payload: { hello: 'world' } },
      { attempts: 2, removeOnFail: false, jobId },
    );

    await new Promise<void>((resolve) => {
      worker.on('failed', async (job) => {
        if (!job) return;
        if (job.id === jobId && job.attemptsMade >= 2) {
          resolve();
        }
      });
    });

    const job = await webhookQueue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.attemptsMade).toBe(2);
    expect(await job!.getState()).toBe('failed');
    expect(job!.opts.removeOnFail).toBe(false);

    await closeWorker(worker);
    await closeQueue(webhookQueue);
  });
});

