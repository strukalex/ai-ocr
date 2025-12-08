import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../../apps/api/src/app/app.module';
import { PrismaService } from '@my-org/database';
import request from 'supertest';
import { QueueService } from '@my-org/queue';

describe('Ingestion Pipeline (integration)', () => {
  let app: INestApplication;

  const prismaMock: Partial<PrismaService> = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    auditEvent: {
      create: jest.fn().mockResolvedValue(undefined),
    } as any,
    document: {
      create: jest.fn().mockResolvedValue({ id: 'doc-1', status: 'Uploaded' }),
    } as any,
    intakeRequest: {
      create: jest.fn().mockResolvedValue({ id: 'intake-1' }),
    } as any,
  };
  const queueMock = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  };
  const queueServiceMock: Partial<QueueService> = {
    createQueue: jest.fn().mockReturnValue(queueMock as any),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(QueueService)
      .useValue(queueServiceMock)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts document upload and enqueues intake job', async () => {
    const payload = {
      sourceChannel: 'upload',
      originalUri: 'file:///tmp/sample.pdf',
      filename: 'sample.pdf',
      checksum: 'sha256-sample',
      idempotencyKey: 'test-ingest-001',
      metadata: { submitter: 'integration-test' },
    };

    await request(app.getHttpServer())
      .post('/api/documents')
      .send(payload)
      .expect(201);

    expect(queueMock.add).toHaveBeenCalledWith(
      'intake',
      expect.objectContaining({
        documentId: 'doc-1',
        checksum: payload.checksum,
        originalUri: payload.originalUri,
      }),
    );
  });
});
