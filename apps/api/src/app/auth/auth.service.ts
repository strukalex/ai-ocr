import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditLogger } from '@my-org/observability';
import { Role, UserContext } from '@my-org/shared-types';
import * as jwt from 'jsonwebtoken';
import jwksClient, { SigningKey, JwksClient } from 'jwks-rsa';

interface JwtClaims extends jwt.JwtPayload {
  preferred_username?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
}

@Injectable()
export class AuthService {
  private jwks: JwksClient | null =
    process.env.JWKS_URL && process.env.JWKS_URL.length > 0
      ? jwksClient({
          jwksUri: process.env.JWKS_URL,
          cache: true,
          cacheMaxEntries: 5,
          cacheMaxAge: 10 * 60 * 1000,
        })
      : null;

  constructor(private readonly audit: AuditLogger) {}

  async verify(authHeader?: string): Promise<UserContext> {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = authHeader.slice('Bearer '.length);
    const decoded = await this.verifyJwt(token);
    const roles =
      decoded.realm_access?.roles ||
      decoded.resource_access?.[process.env.KEYCLOAK_CLIENT_ID ?? 'ai-ocr']?.roles ||
      [];

    const user: UserContext = {
      userId: decoded.sub ?? decoded.preferred_username ?? 'unknown',
      roles: (roles ?? []).filter(Boolean) as Role[],
      email: decoded.email,
      name: decoded.name,
    };

    this.audit.log({
      action: 'auth.verify',
      actorId: user.userId,
      roles: user.roles,
      outcome: 'success',
    });

    return user;
  }

  private async verifyJwt(token: string): Promise<JwtClaims> {
    const publicKey = process.env.KEYCLOAK_PUBLIC_KEY;
    if (publicKey) {
      return jwt.verify(token, publicKey, { algorithms: ['RS256'] }) as JwtClaims;
    }
    if (this.jwks) {
      const decodedHeader = jwt.decode(token, { complete: true });
      const kid = (decodedHeader?.header as jwt.JwtHeader | undefined)?.kid;
      if (!kid) throw new UnauthorizedException('Missing kid');
      const key = await new Promise<SigningKey>((resolve, reject) => {
        this.jwks!.getSigningKey(
          kid,
          (error: Error | null, k?: SigningKey) => {
            if (error || !k) return reject(error ?? new UnauthorizedException('No signing key'));
            resolve(k);
          },
        );
      });
      const signingKey = key.getPublicKey();
      return jwt.verify(token, signingKey, { algorithms: ['RS256'] }) as JwtClaims;
    }
    throw new UnauthorizedException('No verification key configured');
  }
}

