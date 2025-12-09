import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../../apps/api/src/app/app.module';
import { PrismaService } from '@my-org/database';
import { QueueService, withDefaultJobOptions } from '@my-org/queue';
import request from 'supertest';
import { JwtAuthGuard } from '../../../apps/api/src/app/auth/jwt-auth.guard';
import { AuthService } from '../../../apps/api/src/app/auth/auth.service';

describe('Ingestion Telemetry (contract)', () => {
  let app: INestApplication;

  const prismaMock = {
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

  const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(QueueService)
      .useValue(queueServiceMock)
      .overrideProvider(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.user = { userId: 'test-user', roles: [] };
          return true;
        },
      } as any)
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
  });

  afterAll(async () => {
    consoleSpy.mockRestore();
    await app?.getHttpServer()?.close?.();
    await app?.close();
    await prismaMock.$disconnect?.();
  });

  it('propagates trace headers and structured log with trace_id/document_id/user_id', async () => {
    const payload = {
      sourceChannel: 'upload',
      originalUri: 'file:///tmp/sample.pdf',
      filename: 'sample.pdf',
      checksum: 'sha256-sample',
      idempotencyKey: 'contract-ingest-001',
      metadata: { submitter: 'contract-test' },
    };

    const response = await request(app.getHttpServer())
      .post('/api/documents')
      .send(payload)
      .expect(201);

    const traceId = response.headers['trace-id'];
    expect(traceId).toBeDefined();
    expect(response.headers['traceparent']).toBeDefined();

    expect(queueMock.add).toHaveBeenCalledWith(
      'intake',
      expect.objectContaining({
        documentId: 'doc-1',
        traceId,
      }),
      expect.objectContaining({
        backoff: expect.objectContaining({ type: 'exponential' }),
      }),
    );

    const logged = consoleSpy.mock.calls.find((c) => typeof c[0] === 'string');
    expect(logged).toBeDefined();
    const parsed = JSON.parse(logged![0] as string);
    expect(parsed.message).toBe('ingestion.intake_enqueued');
    expect(parsed.traceId).toBe(traceId);
    expect(parsed.documentId).toBe('doc-1');
    expect(parsed.user_id).toBe('test-user');
    expect(parsed.level).toBe('info');
    expect(parsed.timestamp).toBeDefined();
  });
});

