import { UnauthorizedException } from '@nestjs/common';
import { AuditLogger } from '@my-org/observability';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';
import { AuthService } from './auth.service';

jest.mock('axios');

const auditMock = {
  log: jest.fn(),
} as unknown as AuditLogger;

describe('AuthService', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env['KEYCLOAK_TOKEN_URL'];
    delete process.env['KEYCLOAK_CLIENT_ID'];
    delete process.env['KEYCLOAK_CLIENT_SECRET'];
    delete process.env['LOCAL_AUTH_SECRET'];
    delete process.env['LOCAL_AUTH_ROLES'];
  });

  it('issues local JWT tokens when configured without Keycloak', async () => {
    process.env['LOCAL_AUTH_SECRET'] = 'test-secret';
    process.env['LOCAL_AUTH_ROLES'] = 'admin,validator';
    process.env['LOCAL_AUTH_USER'] = 'user1';
    process.env['LOCAL_AUTH_PASSWORD'] = 'pw';

    const service = new AuthService(auditMock);
    const tokens = await service.loginWithPassword({ username: 'user1', password: 'pw' });

    expect(tokens.accessToken).toBeDefined();
    const decoded = jwt.verify(tokens.accessToken, 'test-secret') as jwt.JwtPayload;
    expect(decoded.sub).toBe('user1');
    expect(decoded.roles).toEqual(['admin', 'validator']);
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login', outcome: 'success' }),
    );
  });

  it('delegates to Keycloak token endpoint when configured', async () => {
    process.env['KEYCLOAK_TOKEN_URL'] = 'https://keycloak.example.com/token';
    process.env['KEYCLOAK_CLIENT_ID'] = 'ai-ocr';

    (axios.post as jest.Mock).mockResolvedValue({
      data: { access_token: 'kc-access', refresh_token: 'kc-refresh' },
    });

    const service = new AuthService(auditMock);
    const tokens = await service.loginWithPassword({ username: 'user2', password: 'pw' });

    expect(axios.post).toHaveBeenCalledWith(
      'https://keycloak.example.com/token',
      expect.any(URLSearchParams),
      expect.objectContaining({
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(tokens).toEqual({ accessToken: 'kc-access', refreshToken: 'kc-refresh' });
  });

  it('throws when no auth provider is configured', async () => {
    const service = new AuthService(auditMock);
    await expect(
      service.loginWithPassword({ username: 'user3', password: 'pw' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login', outcome: 'failure' }),
    );
  });

  it('verifies worker tokens signed with WORKER_AUTH_SECRET', async () => {
    process.env['WORKER_AUTH_SECRET'] = 'worker-secret';
    const service = new AuthService(auditMock);
    const token = jwt.sign(
      { serviceId: 'ingestion-worker', roles: ['operator'] },
      'worker-secret',
      { algorithm: 'HS256' },
    );

    const user = await service.verify(`Bearer ${token}`);

    expect(user.userId).toBe('ingestion-worker');
    expect(user.roles).toEqual(['operator']);
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.verify', outcome: 'success' }),
    );
    delete process.env['WORKER_AUTH_SECRET'];
  });
});


