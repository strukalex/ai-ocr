import { Injectable, UnauthorizedException } from '@nestjs/common';
import axios from 'axios';
import { AuditLogger } from '@my-org/observability';
import {
  AuthLoginRequestDto,
  AuthTokens,
  JwtClaims,
  Role,
  UserContext,
} from '@my-org/shared-types';
import * as jwt from 'jsonwebtoken';
import jwksClient, { SigningKey, JwksClient } from 'jwks-rsa';

@Injectable()
export class AuthService {
  private jwks: JwksClient | null =
    process.env['JWKS_URL'] && process.env['JWKS_URL'].length > 0
      ? jwksClient({
          jwksUri: process.env['JWKS_URL'],
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
    const roles = this.resolveRoles(decoded);

    const user: UserContext = {
      userId: decoded.sub ?? decoded.preferred_username ?? 'unknown',
      roles: (roles ?? []).filter(Boolean) as Role[],
      email: decoded['email'],
      name: decoded['name'],
    };

    await this.audit.log({
      action: 'auth.verify',
      actorId: user.userId,
      roles: user.roles,
      outcome: 'success',
    });

    return user;
  }

  async loginWithPassword(payload: AuthLoginRequestDto): Promise<AuthTokens> {
    try {
      const tokens = this.hasKeycloakTokenUrl()
        ? await this.loginWithKeycloak(payload)
        : await this.loginWithLocalSecret(payload);

      await this.audit.log({
        action: 'auth.login',
        actorId: payload.username,
        roles: [],
        outcome: 'success',
      });

      return tokens;
    } catch (err) {
      await this.audit.log({
        action: 'auth.login',
        actorId: payload.username,
        roles: [],
        outcome: 'failure',
        metadata: { error: err instanceof Error ? err.message : 'unknown' },
      });
      throw err;
    }
  }

  private async verifyJwt(token: string): Promise<JwtClaims> {
    const publicKey = process.env['KEYCLOAK_PUBLIC_KEY'];
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

    const localSecret = process.env['LOCAL_AUTH_SECRET'];
    if (localSecret) {
      return jwt.verify(token, localSecret, { algorithms: ['HS256'] }) as JwtClaims;
    }

    throw new UnauthorizedException('No verification key configured');
  }

  private resolveRoles(decoded: JwtClaims): Role[] {
    const clientId = process.env['KEYCLOAK_CLIENT_ID'] ?? 'ai-ocr';
    return (
      decoded.realm_access?.roles ||
      decoded.resource_access?.[clientId]?.roles ||
      decoded.roles ||
      []
    ) as Role[];
  }

  private hasKeycloakTokenUrl(): boolean {
    return !!process.env['KEYCLOAK_TOKEN_URL'];
  }

  private async loginWithKeycloak(payload: AuthLoginRequestDto): Promise<AuthTokens> {
    const tokenUrl = process.env['KEYCLOAK_TOKEN_URL']!;
    const clientId = process.env['KEYCLOAK_CLIENT_ID'] ?? 'ai-ocr';
    const clientSecret = process.env['KEYCLOAK_CLIENT_SECRET'];

    try {
      const response = await axios.post(
        tokenUrl,
        new URLSearchParams({
          grant_type: 'password',
          username: payload.username,
          password: payload.password,
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );

      const accessToken = response.data?.access_token;
      if (!accessToken) {
        throw new UnauthorizedException('Invalid credentials');
      }

      return {
        accessToken,
        refreshToken: response.data?.refresh_token,
      };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Authentication failed');
    }
  }

  private async loginWithLocalSecret(payload: AuthLoginRequestDto): Promise<AuthTokens> {
    const secret = process.env['LOCAL_AUTH_SECRET'];
    if (!secret) {
      throw new UnauthorizedException('No auth provider configured');
    }

    const defaultRoles = (process.env['LOCAL_AUTH_ROLES'] ?? 'operator,admin')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean) as Role[];

    const accessToken = jwt.sign(
      {
        sub: payload.username,
        preferred_username: payload.username,
        roles: defaultRoles,
      },
      secret,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const refreshToken = jwt.sign(
      {
        sub: payload.username,
        type: 'refresh',
      },
      secret,
      { algorithm: 'HS256', expiresIn: '30d' },
    );

    return { accessToken, refreshToken };
  }
}

