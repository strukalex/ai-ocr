import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuditLogger } from '@my-org/observability';
import { MockAuthGuard, UserContext } from '@my-org/shared-types';

@Injectable()
export class AuditAuthGuard implements CanActivate {
  private readonly delegate = new MockAuthGuard();

  constructor(private readonly auditLogger: AuditLogger) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = await Promise.resolve(this.delegate.canActivate(context));
    const request = context.switchToHttp().getRequest();
    const user = (request.user ?? { userId: 'anonymous', roles: [] }) as UserContext;
    this.auditLogger.log({
      action: 'auth',
      userId: user.userId,
      roles: user.roles,
      outcome: allowed ? 'success' : 'failure',
      details: {
        path: request.url,
        method: request.method,
      },
    });
    return allowed;
  }
}

