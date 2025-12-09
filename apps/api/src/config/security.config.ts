export interface SecurityConfig {
  tlsMinVersion: 'TLSv1.2' | 'TLSv1.3';
  requireTls: boolean;
  trustProxy: boolean;
  atRestEncryption: 'AES-256-GCM';
  sessionTimeoutMinutes: number;
  requireAtRestEncryption: boolean;
  storageSseAlgorithm: 'AES256';
}

export const securityConfig: SecurityConfig = {
  tlsMinVersion: 'TLSv1.2',
  requireTls: (process.env['REQUIRE_TLS'] ?? 'true').toLowerCase() === 'true',
  trustProxy: (process.env['TRUST_PROXY'] ?? 'true').toLowerCase() === 'true',
  atRestEncryption: 'AES-256-GCM',
  sessionTimeoutMinutes: Number(process.env['SESSION_IDLE_MINUTES'] ?? 30),
  requireAtRestEncryption: (process.env['REQUIRE_AT_REST_ENCRYPTION'] ?? 'true').toLowerCase() === 'true',
  storageSseAlgorithm: 'AES256',
};

