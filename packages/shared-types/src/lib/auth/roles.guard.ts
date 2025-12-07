import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Role, UserContext } from './auth.interfaces';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly allowedRoles: Role[]) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user: UserContext | undefined = request.user;
    if (!user) {
      return false;
    }
    return user.roles.some((role) => this.allowedRoles.includes(role));
  }
}

