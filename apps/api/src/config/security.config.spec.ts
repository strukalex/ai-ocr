import { SecurityConfig } from './security.config';

const originalEnv = { ...process.env };

describe('securityConfig env parsing', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  function loadConfig(): SecurityConfig {
    // Re-require after env changes to refresh the computed constant.
    return require('./security.config').securityConfig as SecurityConfig;
  }

  it('defaults to require TLS and at-rest encryption when env unset', () => {
    delete process.env.REQUIRE_TLS;
    delete process.env.REQUIRE_AT_REST_ENCRYPTION;
    const cfg = loadConfig();
    expect(cfg.requireTls).toBe(true);
    expect(cfg.requireAtRestEncryption).toBe(true);
  });

  it('treats non-"true" values as disabled', () => {
    process.env.REQUIRE_TLS = 'False';
    process.env.REQUIRE_AT_REST_ENCRYPTION = 'disabled';
    const cfg = loadConfig();
    expect(cfg.requireTls).toBe(false);
    expect(cfg.requireAtRestEncryption).toBe(false);
  });

  it('enables only when explicitly set to "true"', () => {
    process.env.REQUIRE_TLS = 'true';
    process.env.REQUIRE_AT_REST_ENCRYPTION = 'TRUE';
    const cfg = loadConfig();
    expect(cfg.requireTls).toBe(true);
    expect(cfg.requireAtRestEncryption).toBe(true);
  });
});

