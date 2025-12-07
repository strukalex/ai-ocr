import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { UserContext } from './auth.interfaces';

@Injectable()
export class MockAuthGuard implements CanActivate {
  constructor(private readonly mockUser?: UserContext) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (!request.user) {
      request.user =
        this.mockUser ?? ({ userId: 'mock-user', roles: ['admin'] } satisfies UserContext);
    }
    return true;
  }
}

