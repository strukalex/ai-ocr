export interface TlsConfig {
  certFile?: string;
  keyFile?: string;
}

export function loadTlsConfig(): TlsConfig {
  return {
    certFile: process.env.TLS_CERT_FILE,
    keyFile: process.env.TLS_KEY_FILE,
  };
}

