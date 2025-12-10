import {
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import request from 'supertest';
import { execSync } from 'child_process';
import path from 'path';

import { AppModule } from '../../../apps/api/src/app/app.module';
import { JwtAuthGuard } from '../../../apps/api/src/app/auth/jwt-auth.guard';
import { AuthService } from '../../../apps/api/src/app/auth/auth.service';
import { PrismaService } from '@my-org/database';
import { SourceChannel } from '@my-org/shared-types';
import { DocumentsService } from '../../../apps/api/src/app/documents/documents.service';

jest.setTimeout(120_000);

describe('Intake Sources API (testcontainers)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let documents: DocumentsService;

  const authGuardMock = {
    canActivate: (context: any) => {
      const req = context.switchToHttp().getRequest();
      const auth = req.headers['authorization'];
      if (!auth) {
        throw new UnauthorizedException();
      }
      if (auth === 'Bearer viewer-token') {
        req.user = { userId: 'viewer', roles: ['viewer'] };
        return true;
      }
      if (auth === 'Bearer operator-token') {
        req.user = { userId: 'operator', roles: ['operator'] };
        return true;
      }
      throw new ForbiddenException();
    },
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
      .overrideProvider(JwtAuthGuard)
      .useValue(authGuardMock)
      .overrideProvider(AuthService)
      .useValue({
        verify: jest.fn().mockImplementation((token?: string) => {
          if (!token) throw new UnauthorizedException();
          if (token === 'Bearer viewer-token') {
            return { userId: 'viewer', roles: ['viewer'] };
          }
          return { userId: 'operator', roles: ['operator'] };
        }),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    prisma = app.get(PrismaService);
    documents = app.get(DocumentsService);
  });

  afterEach(async () => {
    await prisma.intakeSource.deleteMany({});
  });

  afterAll(async () => {
    // Close queues to avoid reconnect attempts after Redis stops.
    try {
      await (documents as any)?.intakeQueue?.close?.();
    } catch {
      /* ignore */
    }
    await app?.close();
    await redis?.stop();
    await pg?.stop();
  });

  it('rejects unauthorized and forbidden requests', async () => {
    const payload = {
      type: SourceChannel.WatchedStorage,
      uri: 's3://bucket/path',
      pollingIntervalSeconds: 10,
    };

    await request(app.getHttpServer()).post('/api/intake/sources').send(payload).expect(401);

    await request(app.getHttpServer())
      .post('/api/intake/sources')
      .set('Authorization', 'Bearer viewer-token')
      .send(payload)
      .expect(403);
  });

  it('validates payloads', async () => {
    const badPayload = {
      type: 'upload',
      uri: 'notaurl',
      pollingIntervalSeconds: 1,
    };

    await request(app.getHttpServer())
      .post('/api/intake/sources')
      .set('Authorization', 'Bearer operator-token')
      .send(badPayload)
      .expect(400);
  });

  it('creates, lists, updates, and disables intake sources', async () => {
    const payload = {
      type: SourceChannel.WatchedStorage,
      uri: 's3://documents/watched/',
      pollingIntervalSeconds: 15,
      credentialsRef: 's3-prod-creds',
    };

    const createRes = await request(app.getHttpServer())
      .post('/api/intake/sources')
      .set('Authorization', 'Bearer operator-token')
      .send(payload)
      .expect(201);

    expect(createRes.body.id).toBeDefined();
    expect(createRes.body.active).toBe(true);
    expect(createRes.body.uri).toBe(payload.uri);

    const listRes = await request(app.getHttpServer())
      .get('/api/intake/sources')
      .set('Authorization', 'Bearer operator-token')
      .expect(200);
    expect(listRes.body.length).toBe(1);
    expect(listRes.body[0].credentialsRef).toBe('s3-prod-creds');

    const updateRes = await request(app.getHttpServer())
      .patch(`/api/intake/sources/${createRes.body.id}`)
      .set('Authorization', 'Bearer operator-token')
      .send({ pollingIntervalSeconds: 30, active: false })
      .expect(200);

    expect(updateRes.body.pollingIntervalSeconds).toBe(30);
    expect(updateRes.body.active).toBe(false);

    await request(app.getHttpServer())
      .delete(`/api/intake/sources/${createRes.body.id}`)
      .set('Authorization', 'Bearer operator-token')
      .expect(204);

    const final = await prisma.intakeSource.findUnique({ where: { id: createRes.body.id } });
    expect(final?.active).toBe(false);
  });
});

