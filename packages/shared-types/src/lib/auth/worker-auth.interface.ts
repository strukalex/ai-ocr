import { Role } from './auth.interfaces';

export interface WorkerAuthContext {
  serviceId: string;
  roles: Role[];
}

export interface WorkerAuthTokenPayload extends WorkerAuthContext {
  aud?: string;
  exp?: number;
  iat?: number;
}

