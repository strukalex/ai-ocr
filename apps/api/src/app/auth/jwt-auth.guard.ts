import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditLogger } from '@my-org/observability';
import { AuthService } from './auth.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly audit: AuditLogger,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const isPublic = this.reflector.get<boolean>('isPublic', context.getHandler());
    if (isPublic) {
      return true;
    }
    try {
      const user = await this.authService.verify(request.headers.authorization);
      request.user = user;
      return true;
    } catch (err) {
      this.audit.log({
        action: 'auth.verify',
        outcome: 'failure',
        resource: request.url,
        metadata: { path: request.url },
      });
      throw err instanceof UnauthorizedException ? err : new UnauthorizedException();
    }
  }
}

