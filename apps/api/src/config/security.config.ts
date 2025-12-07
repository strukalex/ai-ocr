export interface SecurityConfig {
  tlsMinVersion: 'TLSv1.2' | 'TLSv1.3';
  atRestEncryption: 'AES-256-GCM';
  sessionTimeoutMinutes: number;
}

export const securityConfig: SecurityConfig = {
  tlsMinVersion: 'TLSv1.2',
  atRestEncryption: 'AES-256-GCM',
  sessionTimeoutMinutes: 30,
};

