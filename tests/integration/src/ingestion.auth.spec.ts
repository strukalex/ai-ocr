import {
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../../apps/api/src/app/app.module';
import { JwtAuthGuard } from '../../../apps/api/src/app/auth/jwt-auth.guard';
import { AuthService } from '../../../apps/api/src/app/auth/auth.service';
import { PrismaService } from '@my-org/database';
import { QueueService, withDefaultJobOptions } from '@my-org/queue';
import { LoggerService, AuditLogger } from '@my-org/observability';

describe('Ingestion AuthZ (integration)', () => {
  let app: INestApplication;

  const prismaMock = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    auditEvent: {
      create: jest.fn().mockResolvedValue(undefined),
    } as any,
    document: {
      create: jest.fn().mockResolvedValue({ id: 'doc-auth', status: 'Uploaded' }),
      findFirst: jest.fn().mockResolvedValue(null),
    } as any,
    intakeRequest: {
      create: jest.fn().mockResolvedValue({ id: 'intake-auth' }),
    } as any,
  } as unknown as PrismaService;

  const queueMock = {
    add: jest.fn().mockResolvedValue({ id: 'job-auth' }),
  };
  const queueServiceMock: Partial<QueueService> = {
    createQueue: jest.fn().mockReturnValue(queueMock as any),
    enqueue: jest.fn(async (queue: any, name: string, data: any, options?: any) =>
      queue.add(name, data, withDefaultJobOptions(options)),
    ),
  };

  const loggerMock: Partial<LoggerService> = {
    info: jest.fn(),
    warn: jest.fn(),
  };
  const auditMock: Partial<AuditLogger> = {
    log: jest.fn(),
  };

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
      .overrideProvider(AuditLogger)
      .useValue(auditMock)
      .overrideProvider(AuthService)
      .useValue({
        verify: jest.fn(async (authHeader?: string) => {
          if (!authHeader) {
            throw new UnauthorizedException();
          }
          if (authHeader === 'Bearer viewer-token') {
            throw new ForbiddenException();
          }
          return { userId: 'auth-user', roles: ['operator'] };
        }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  const makePayload = () => ({
    sourceChannel: 'upload',
    originalUri: 'file:///tmp/sample.pdf',
    filename: 'sample.pdf',
    checksum: 'sha256-auth',
    idempotencyKey: 'auth-idem-1',
  });

  it('returns 401 when Authorization header is missing', async () => {
    await request(app.getHttpServer()).post('/api/documents').send(makePayload()).expect(401);
    expect(queueMock.add).not.toHaveBeenCalled();
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.verify',
        outcome: 'failure',
        resource: '/api/documents',
      }),
    );
  });

  it('returns 401 when user lacks required role', async () => {
    await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', 'Bearer viewer-token')
      .send(makePayload())
      .expect(401);
    expect(queueMock.add).not.toHaveBeenCalled();
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.verify',
        outcome: 'failure',
        resource: '/api/documents',
      }),
    );
  });

  it('allows operator token and enqueues intake job', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/documents')
      .set('Authorization', 'Bearer operator-token')
      .send(makePayload())
      .expect(201);

    expect(res.body.documentId).toBe('doc-auth');
    expect(queueMock.add).toHaveBeenCalledWith(
      'intake',
      expect.objectContaining({
        documentId: 'doc-auth',
        checksum: 'sha256-auth',
      }),
      expect.anything(),
    );
  });
});


