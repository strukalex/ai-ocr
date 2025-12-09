import { Injectable } from '@nestjs/common';
import { LoggerService } from '@my-org/observability';
import { Role, signWorkerToken } from '@my-org/shared-types';

const DEFAULT_ROLES: Role[] = ['operator'];

@Injectable()
export class WorkerAuthService {
  constructor(private readonly logger: LoggerService) {}

  signServiceToken(roles: Role[] = DEFAULT_ROLES): string | null {
    const token = signWorkerToken({ roles });
    if (!token) {
      this.logger.warn('worker-auth.missing_secret', {});
      return null;
    }
    return token;
  }

  buildAuthHeader(roles?: Role[]): string | null {
    const token = this.signServiceToken(roles);
    return token ? `Bearer ${token}` : null;
  }
}


