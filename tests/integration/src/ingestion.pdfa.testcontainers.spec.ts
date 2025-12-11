import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { execSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import request from 'supertest';
import { Queue } from 'bullmq';
import { PDFDocument } from 'pdf-lib';
import { Client as MinioClient } from 'minio';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { AppModule } from '../../../apps/api/src/app/app.module';
import { JwtAuthGuard } from '../../../apps/api/src/app/auth/jwt-auth.guard';
import { AuthService } from '../../../apps/api/src/app/auth/auth.service';
import { PrismaService } from '@my-org/database';
import { QueueService } from '@my-org/queue';
import { StorageService } from '@my-org/storage';
import { AuditLogger, LoggerService } from '@my-org/observability';
import { IntakeProcessor } from '../../../apps/workers/ingestion-worker/src/app/processors/intake.processor';
import { NormalizationService } from '../../../apps/workers/ingestion-worker/src/app/services/normalization.service';
import { PreprocessingService } from '../../../apps/workers/ingestion-worker/src/app/services/preprocessing.service';
import { DocumentStatus, SourceChannel } from '@my-org/shared-types';

jest.setTimeout(120_000);

const closeQueue = async (q?: Queue) => {
  if (!q) return;
  try {
    await q.close();
  } catch {
    /* ignore */
  }
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

const ghostscriptAvailable = (): boolean => {
  execSync('gs -version', { stdio: 'ignore' });
  return true;
};

describe('Ingestion PDF/A normalization (testcontainers)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queueService: TrackingQueueService;
  let logger: LoggerService;
  let audit: AuditLogger;
  let intakeQueue: Queue;
  let tmpDir: string;
  let storage: StorageService;
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let minio: StartedTestContainer;

  const minioConfig = {
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
    bucket: 'documents-pdfa',
  };

  beforeAll(async () => {
    // Fail fast if Ghostscript is missing; PDF/A coverage must run.
    ghostscriptAvailable();

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
      })
      .withCommand(['server', '/data'])
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    process.env['DATABASE_URL'] = `postgresql://test:test@${pg.getHost()}:${pg.getMappedPort(5432)}/test`;
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

    // BullMQ forbids ':' in jobIds; sanitize to align with worker usage in tests.
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

    storage = new StorageService({
      endPoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
      port: Number(process.env['MINIO_PORT'] ?? 9000),
      useSSL: false,
      accessKey: minioConfig.accessKey,
      secretKey: minioConfig.secretKey,
      defaultBucket: minioConfig.bucket,
      sseAlgorithm: 'AES256',
      enforceSse: false,
    });
    await storage.ensureBucket(minioConfig.bucket);

    intakeQueue = queueService.createQueue('intake');
    tmpDir = await mkdtemp(path.join(tmpdir(), 'ingest-pdfa-'));
  });

  afterEach(async () => {
    if (prisma) {
      await prisma.intakeRequest.deleteMany({}).catch(() => undefined);
      await prisma.document.deleteMany({}).catch(() => undefined);
    }
    await intakeQueue?.obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    if (!ghostscriptAvailable()) return;
    await queueService.closeAll().catch(() => undefined);
    await closeQueue(intakeQueue);
    await app?.close();
    await minio?.stop();
    await redis?.stop();
    await pg?.stop();
  });

  const buildProcessor = () => {
    const normalization = new NormalizationService(logger);
    return new IntakeProcessor(
      prisma,
      audit,
      logger,
      storage,
      new PreprocessingService(logger, storage, {
        buildAuthHeader: () => 'Bearer test-token',
      } as any),
      normalization,
      queueService,
    );
  };

  it('converts to PDF/A and stores canonical artifact with checksum metadata', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 300]);
    page.drawText('pdfa-normalization');
    const pdfBuffer = Buffer.from(await pdf.save());
    const checksum = createHash('sha256').update(pdfBuffer).digest('hex');
    const filePath = path.join(tmpDir, `sample-${randomUUID()}.pdf`);
    await writeFile(filePath, pdfBuffer);

    const payload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${filePath}`,
      filename: path.basename(filePath),
      checksum,
      idempotencyKey: `idem-${checksum}`,
      metadata: { rawContentBase64: pdfBuffer.toString('base64') },
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

    const canonicalKey = `canonical/${checksum}.pdfa`;
    const canonicalStat = await minioClient.statObject(bucket, canonicalKey);
    expect(canonicalStat).toBeDefined();
    expect(canonicalStat.metaData?.['checksum-sha256']).toBeDefined();

    const canonicalBuffer = await storage.downloadObject(canonicalKey, bucket);
    expect(canonicalBuffer.length).toBeGreaterThan(pdfBuffer.length);
    expect(canonicalBuffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(canonicalBuffer.toString('utf-8')).toContain('pdfaid');

    const doc = await prisma.document.findUnique({ where: { id: res.body.documentId } });
    expect(doc?.status).toBe(DocumentStatus.Uploaded);
    expect(doc?.canonicalUri).toContain(canonicalKey);
  });

  it('converts PNG input to PDF/A and stores canonical artifact with checksum metadata', async () => {
    const pngBuffer = Buffer.from(
      // 32x32 PNG (valid sample used in preprocessing tests)
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAAmL/9dAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH5AwMDx0bWf0XJgAAAB10RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAAANSURBVFjD7cEBDQAAAMKg909tDjegAAAAAAAAAAAA4GkAAToAAZR+9qsAAAAASUVORK5CYII=',
      'base64',
    );
    const checksum = createHash('sha256').update(pngBuffer).digest('hex');
    const filePath = path.join(tmpDir, `sample-${randomUUID()}.png`);
    await writeFile(filePath, pngBuffer);

    const payload = {
      sourceChannel: SourceChannel.Upload,
      originalUri: `file://${filePath}`,
      filename: path.basename(filePath),
      checksum,
      idempotencyKey: `idem-${checksum}-png`,
      metadata: { rawContentBase64: pngBuffer.toString('base64') },
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

    const canonicalKey = `canonical/${checksum}.pdfa`;
    const canonicalStat = await minioClient.statObject(bucket, canonicalKey);
    expect(canonicalStat).toBeDefined();
    expect(canonicalStat.metaData?.['checksum-sha256']).toBeDefined();

    const canonicalBuffer = await storage.downloadObject(canonicalKey, bucket);
    expect(canonicalBuffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(canonicalBuffer.toString('utf-8')).toContain('pdfaid');

    const doc = await prisma.document.findUnique({ where: { id: res.body.documentId } });
    expect(doc?.status).toBe(DocumentStatus.Uploaded);
    expect(doc?.canonicalUri).toContain(canonicalKey);
  });
});

