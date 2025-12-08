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
    await this.auditLogger.log({
      action: 'auth',
      actorId: user.userId,
      roles: user.roles,
      outcome: allowed ? 'success' : 'failure',
      resource: request.url,
      metadata: {
        path: request.url,
        method: request.method,
      },
    });
    return allowed;
  }
}

