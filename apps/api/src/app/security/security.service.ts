import { Injectable, OnModuleInit } from '@nestjs/common';
import { SecurityConfig, securityConfig } from '../../config/security.config';

@Injectable()
export class SecurityConfigService implements OnModuleInit {
  get config(): SecurityConfig {
    return securityConfig;
  }

  onModuleInit(): void {
    this.validateAtRestEncryption();
  }

  /**
   * Basic safeguard to prevent running without at-rest encryption in enforced environments.
   * For DB, we rely on environment readiness signals surfaced by ops (e.g., disk/TDE flags).
   */
  validateAtRestEncryption(): void {
    const forceChecks =
      (process.env['FORCE_SECURITY_VALIDATION_IN_TEST'] ?? 'false').toLowerCase() === 'true';
    const requireEncryption =
      forceChecks ||
      (process.env['REQUIRE_AT_REST_ENCRYPTION'] ?? 'true').toLowerCase() === 'true';
    if (!requireEncryption) return;

    const isJest = process.env['JEST_WORKER_ID'] !== undefined;
    const isTestEnv = (process.env['NODE_ENV'] ?? '').toLowerCase() === 'test';
    if ((isTestEnv || isJest) && !forceChecks) return;

    const storageOk =
      (process.env['MINIO_ENFORCE_SSE'] ?? 'true').toLowerCase() === 'true' &&
      (process.env['MINIO_SSE_ALGORITHM'] ?? 'AES256').length > 0;

    const dbEncrypted =
      (process.env['DB_AT_REST_ENCRYPTED'] ?? process.env['DATABASE_ENCRYPTION_ENABLED'] ?? '').toLowerCase() ===
      'true';

    if (!storageOk) {
      throw new Error('Storage SSE must remain enabled (MINIO_ENFORCE_SSE=true with valid algorithm).');
    }

    if (!dbEncrypted) {
      throw new Error(
        'Database at-rest encryption flag not set. Set DB_AT_REST_ENCRYPTED=true (or DATABASE_ENCRYPTION_ENABLED=true) when encryption is enabled in the environment.',
      );
    }
  }
}

