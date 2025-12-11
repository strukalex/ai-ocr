import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BullBoardDashboardModule } from './bull-board.module';
import { AuthService } from '../auth/auth.service';
import { AuditLogger } from '@my-org/observability';
import request from 'supertest';
import { getQueueToken } from '@nestjs/bullmq';
import { Role, UserContext } from '@my-org/shared-types';
import { QUEUE_OPTIONS_TOKEN } from '@my-org/queue';
import { PrismaService } from '@my-org/database';

describe('BullBoardDashboardModule (auth middleware)', () => {
  let app: INestApplication;
  const authServiceMock = {
    verify: jest.fn(),
  };
  const auditLoggerMock = {
    log: jest.fn(),
  };

  const queueStub = (name: string) =>
    ({
      name,
      metaValues: { version: 'bullmq:stub' },
    }) as any;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BullBoardDashboardModule],
    })
      .overrideProvider(QUEUE_OPTIONS_TOKEN)
      .useValue({ redisUrl: 'redis://localhost:6379', queuePrefix: 'bull' })
      .overrideProvider(AuthService)
      .useValue(authServiceMock)
      .overrideProvider(AuditLogger)
      .useValue(auditLoggerMock)
      .overrideProvider(PrismaService)
      .useValue({
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
      })
      .overrideProvider(getQueueToken('intake'))
      .useValue(queueStub('intake'))
      .overrideProvider(getQueueToken('split'))
      .useValue(queueStub('split'))
      .overrideProvider(getQueueToken('classify'))
      .useValue(queueStub('classify'))
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['BULL_BOARD_ALLOW_LOCAL'];
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 401 when Authorization is missing or invalid', async () => {
    authServiceMock.verify.mockRejectedValueOnce(new UnauthorizedException());

    await request(app.getHttpServer()).get('/admin/queues').expect(401);
  });

  it('returns 403 when user lacks admin role', async () => {
    const user: UserContext = { userId: 'user-1', roles: ['viewer' as Role] };
    authServiceMock.verify.mockResolvedValueOnce(user);

    await request(app.getHttpServer()).get('/admin/queues').expect(403);
  });

  it('allows loopback access when BULL_BOARD_ALLOW_LOCAL=true', async () => {
    process.env['BULL_BOARD_ALLOW_LOCAL'] = 'true';
    await request(app.getHttpServer()).get('/admin/queues').expect(200);
  });
});


