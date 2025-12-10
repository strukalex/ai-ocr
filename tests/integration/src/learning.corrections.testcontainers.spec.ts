import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import request from 'supertest';
import { execSync } from 'child_process';
import path from 'path';

import { AppModule } from '../../../apps/api/src/app/app.module';
import { JwtAuthGuard } from '../../../apps/api/src/app/auth/jwt-auth.guard';
import { AuthService } from '../../../apps/api/src/app/auth/auth.service';
import { PrismaService } from '@my-org/database';
import { QueueService } from '@my-org/queue';

jest.setTimeout(90_000);

describe('Learning corrections summary (testcontainers)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;

  // Minimal QueueService stub to avoid real BullMQ connections in this suite.
  const queueStub: Partial<QueueService> = {
    createQueue: () =>
      ({
        close: async () => undefined,
      } as any),
    enqueue: async () => ({} as any),
    createWorker: () =>
      ({
        close: async () => undefined,
      } as any),
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

    process.env['DATABASE_URL'] = `postgresql://test:test@${pg.getHost()}:${pg.getMappedPort(5432)}/test`;
    process.env['REDIS_URL'] = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

    execSync('npx prisma db push --skip-generate --schema packages/database/prisma/schema.prisma', {
      cwd: path.join(__dirname, '../../..'),
      env: { ...process.env },
      stdio: 'inherit',
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(QueueService)
      .useValue(queueStub)
      .overrideProvider(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = { userId: 'test-user', roles: ['operator'] };
          return true;
        },
      })
      .overrideProvider(AuthService)
      .useValue({
        verify: jest.fn().mockResolvedValue({ userId: 'test-user', roles: ['operator'] }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    await prisma.correctionLog.deleteMany({});
  });

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await pg?.stop();
  });

  it('returns aggregated counts with windowing and tracked-not-enforced flag', async () => {
    const docId1 = 'doc-corr-1';
    const docId2 = 'doc-corr-2';

    await prisma.document.createMany({
      data: [
        {
          id: docId1,
          sourceChannel: 'upload',
          checksum: 'c1',
          status: 'Uploaded',
          originalUri: 'file:///tmp/doc1.pdf',
        },
        {
          id: docId2,
          sourceChannel: 'upload',
          checksum: 'c2',
          status: 'Uploaded',
          originalUri: 'file:///tmp/doc2.pdf',
        },
      ],
    });

    await prisma.correctionLog.createMany({
      data: [
        {
          documentId: docId1,
          documentType: 'invoice',
          fieldPath: 'total',
          correctedValue: '100.00',
          previousValue: '90.00',
          reasonCode: 'manual',
        },
        {
          documentId: docId2,
          documentType: 'invoice',
          fieldPath: 'total',
          correctedValue: '200.00',
          previousValue: '0.00',
          reasonCode: 'manual',
          createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // older event
        },
      ],
    });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const res = await request(app.getHttpServer())
      .get('/api/learning/corrections/summary')
      .query({ documentType: 'invoice', fieldPath: 'total', since })
      .expect(200);

    expect(res.body).toEqual([
      expect.objectContaining({
        documentType: 'invoice',
        fieldPath: 'total',
        occurrences: 2,
        windowOccurrences: 1,
        windowApplied: true,
        windowSince: since,
        trackedNotEnforced: true,
      }),
    ]);
  });
});

