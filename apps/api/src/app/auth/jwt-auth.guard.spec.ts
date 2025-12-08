import { JwtAuthGuard } from './jwt-auth.guard';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuditLogger } from '@my-org/observability';
import { AuthService } from './auth.service';
import { Reflector } from '@nestjs/core';

const mockAudit = { log: jest.fn() } as unknown as AuditLogger;
const mockAuth = {
  verify: jest.fn(),
} as unknown as AuthService;

function buildContext(headers: Record<string, string | undefined>) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
    getHandler: () => ({}),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('allows when verify succeeds', async () => {
    mockAuth.verify = jest.fn().mockResolvedValue({ userId: 'u', roles: [] });
    const guard = new JwtAuthGuard(mockAuth, mockAudit, new Reflector());
    const can = await guard.canActivate(buildContext({ authorization: 'Bearer token' }));
    expect(can).toBe(true);
    expect(mockAudit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure' }),
    );
  });

  it('throws 401 and logs failure on verify error', async () => {
    mockAuth.verify = jest.fn().mockRejectedValue(new UnauthorizedException());
    const guard = new JwtAuthGuard(mockAuth, mockAudit, new Reflector());
    await expect(
      guard.canActivate(buildContext({ authorization: 'bad' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.verify', outcome: 'failure' }),
    );
  });
});

