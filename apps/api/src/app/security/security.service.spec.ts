import { SecurityConfigService } from './security.service';

const originalEnv = { ...process.env };

describe('SecurityConfigService', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('passes validation when DB flag is set and SSE enforced', () => {
    process.env.MINIO_ENFORCE_SSE = 'true';
    process.env.MINIO_SSE_ALGORITHM = 'AES256';
    process.env.DB_AT_REST_ENCRYPTED = 'true';
    const svc = new SecurityConfigService();

    expect(() => svc.validateAtRestEncryption()).not.toThrow();
  });

  it('skips validation in test env', () => {
    process.env.NODE_ENV = 'test';
    process.env.DB_AT_REST_ENCRYPTED = undefined;
    const svc = new SecurityConfigService();

    expect(() => svc.validateAtRestEncryption()).not.toThrow();
  });

  it('throws when DB encryption flag is missing in non-test env', () => {
    process.env.NODE_ENV = 'development';
    process.env.FORCE_SECURITY_VALIDATION_IN_TEST = 'true';
    process.env.DB_AT_REST_ENCRYPTED = '';
    process.env.MINIO_ENFORCE_SSE = 'true';
    process.env.MINIO_SSE_ALGORITHM = 'AES256';
    const svc = new SecurityConfigService();

    expect(() => svc.validateAtRestEncryption()).toThrow(/Database at-rest encryption flag not set/i);
  });

  it('throws when storage SSE is disabled', () => {
    process.env.NODE_ENV = 'development';
    process.env.FORCE_SECURITY_VALIDATION_IN_TEST = 'true';
    process.env.DB_AT_REST_ENCRYPTED = 'true';
    process.env.MINIO_ENFORCE_SSE = 'false';
    const svc = new SecurityConfigService();

    expect(() => svc.validateAtRestEncryption()).toThrow(/Storage SSE must remain enabled/i);
  });
});
