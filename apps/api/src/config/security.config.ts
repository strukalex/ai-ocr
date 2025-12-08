export interface SecurityConfig {
  tlsMinVersion: 'TLSv1.2' | 'TLSv1.3';
  atRestEncryption: 'AES-256-GCM';
  sessionTimeoutMinutes: number;
  requireAtRestEncryption: boolean;
  storageSseAlgorithm: 'AES256';
}

export const securityConfig: SecurityConfig = {
  tlsMinVersion: 'TLSv1.2',
  atRestEncryption: 'AES-256-GCM',
  sessionTimeoutMinutes: 30,
  requireAtRestEncryption: true,
  storageSseAlgorithm: 'AES256',
};

