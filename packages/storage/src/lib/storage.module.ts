import { Module } from '@nestjs/common';
import { StorageService, StorageModuleOptions } from './storage.service';
import { STORAGE_OPTIONS_TOKEN } from './storage.tokens';

@Module({
  providers: [
    {
      provide: STORAGE_OPTIONS_TOKEN,
      useFactory: (): StorageModuleOptions => ({
        endPoint: process.env['MINIO_ENDPOINT'] ?? 'localhost',
        port: process.env['MINIO_PORT'] ? Number(process.env['MINIO_PORT']) : 9000,
        useSSL: (process.env['MINIO_USE_SSL'] ?? 'false').toLowerCase() === 'true',
        accessKey: process.env['MINIO_ACCESS_KEY'],
        secretKey: process.env['MINIO_SECRET_KEY'],
        defaultBucket: process.env['MINIO_BUCKET'] ?? 'documents',
        sseAlgorithm:
          (process.env['MINIO_SSE_ALGORITHM'] as StorageModuleOptions['sseAlgorithm']) ?? 'AES256',
        enforceSse: (process.env['MINIO_ENFORCE_SSE'] ?? 'true').toLowerCase() === 'true',
      }),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}

