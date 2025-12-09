import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../../apps/api/src/app/app.module';
import { PrismaService } from '@my-org/database';
import { JwtAuthGuard } from '../../../apps/api/src/app/auth/jwt-auth.guard';
import { AuthService } from '../../../apps/api/src/app/auth/auth.service';

describe('Learning Corrections Summary (contract)', () => {
  let app: INestApplication;

  const correctionLogMock = {
    groupBy: jest.fn(),
  };

  const prismaMock = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    correctionLog: correctionLogMock,
  } as unknown as PrismaService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
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

  afterEach(() => {
    correctionLogMock.groupBy.mockReset();
  });

  afterAll(async () => {
    await app?.getHttpServer()?.close?.();
    await app?.close();
    await prismaMock.$disconnect?.();
  });

  it('returns counts with windowing and not-enforced flag', async () => {
    const allTime = [
      {
        documentType: 'invoice',
        fieldPath: 'total',
        _count: { _all: 5 },
        _max: { createdAt: new Date('2025-01-10T00:00:00.000Z') },
      },
    ];
    const windowed = [
      {
        documentType: 'invoice',
        fieldPath: 'total',
        _count: { _all: 2 },
        _max: { createdAt: new Date('2025-01-09T00:00:00.000Z') },
      },
    ];

    correctionLogMock.groupBy
      .mockResolvedValueOnce(allTime)
      .mockResolvedValueOnce(windowed);

    const since = '2025-01-05T00:00:00.000Z';
    const res = await request(app.getHttpServer())
      .get('/api/learning/corrections/summary')
      .query({
        documentType: 'invoice',
        fieldPath: 'total',
        since,
      })
      .expect(200);

    expect(correctionLogMock.groupBy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          documentType: 'invoice',
          fieldPath: 'total',
        },
      }),
    );
    expect(correctionLogMock.groupBy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          documentType: 'invoice',
          fieldPath: 'total',
          createdAt: { gte: new Date(since) },
        }),
      }),
    );

    expect(res.body).toEqual([
      expect.objectContaining({
        documentType: 'invoice',
        fieldPath: 'total',
        occurrences: 5,
        windowOccurrences: 2,
        windowApplied: true,
        windowSince: since,
        trackedNotEnforced: true,
        latestCorrectionAt: '2025-01-10T00:00:00.000Z',
      }),
    ]);
  });
});

