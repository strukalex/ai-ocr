import jwt from 'jsonwebtoken';
import { Role } from './auth.interfaces';
import { WorkerAuthTokenPayload } from './worker-auth.interface';

export interface WorkerTokenOptions {
  serviceId?: string;
  roles?: Role[];
  audience?: string;
  ttl?: string;
}

const defaultRoles: Role[] = ['operator'];

function resolveSecret(): string | null {
  return process.env['WORKER_AUTH_SECRET'] ?? process.env['LOCAL_AUTH_SECRET'] ?? null;
}

function resolveAudience(audience?: string): string {
  return audience ?? process.env['WORKER_AUTH_AUDIENCE'] ?? 'api';
}

function resolveServiceId(serviceId?: string): string {
  return serviceId ?? process.env['WORKER_SERVICE_ID'] ?? 'worker-service';
}

export function signWorkerToken(options: WorkerTokenOptions = {}): string | null {
  const secret = resolveSecret();
  if (!secret) return null;

  const payload: WorkerAuthTokenPayload = {
    serviceId: resolveServiceId(options.serviceId),
    roles: options.roles ?? defaultRoles,
    aud: resolveAudience(options.audience),
  };

  const expiresIn = (options.ttl ?? process.env['WORKER_AUTH_TTL'] ?? '15m') as jwt.SignOptions['expiresIn'];

  const signOptions: jwt.SignOptions = {
    algorithm: 'HS256',
    expiresIn,
  };

  return jwt.sign(payload, secret as jwt.Secret, signOptions);
}

export function verifyWorkerToken(
  token: string,
  expectedAudience?: string,
): WorkerAuthTokenPayload | null {
  const secret = resolveSecret();
  if (!secret) return null;

  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as WorkerAuthTokenPayload;
    const aud = decoded.aud ?? resolveAudience();
    const expectedAud = resolveAudience(expectedAudience);
    if (aud !== expectedAud) return null;
    return decoded?.serviceId ? decoded : null;
  } catch {
    return null;
  }
}

