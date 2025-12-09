import { Inject, Injectable } from '@nestjs/common';
import { Client, ItemBucketMetadata } from 'minio';
import { STORAGE_OPTIONS_TOKEN } from './storage.tokens';

export interface StorageModuleOptions {
  endPoint: string;
  port?: number;
  useSSL?: boolean;
  accessKey?: string;
  secretKey?: string;
  defaultBucket?: string;
  /** Server-side encryption algorithm (defaults to AES256) */
  sseAlgorithm?: 'AES256' | 'aws:kms';
  /** Enforce SSE on all uploads (default: true) */
  enforceSse?: boolean;
}

@Injectable()
export class StorageService {
  private client: Client;
  private defaultBucket: string;
  private sseAlgorithm: 'AES256' | 'aws:kms';
  private enforceSse: boolean;

  constructor(
    @Inject(STORAGE_OPTIONS_TOKEN) private readonly options: StorageModuleOptions,
  ) {
    this.defaultBucket = options.defaultBucket ?? 'documents';
    this.sseAlgorithm = options.sseAlgorithm ?? 'AES256';
    this.enforceSse = options.enforceSse ?? true;
    this.client = new Client({
      endPoint: options.endPoint,
      port: options.port ?? 9000,
      useSSL: options.useSSL ?? false,
      accessKey: options.accessKey ?? 'minioadmin',
      secretKey: options.secretKey ?? 'minioadmin',
    });
  }

  async ensureBucket(bucket = this.defaultBucket): Promise<void> {
    const exists = await this.client.bucketExists(bucket);
    if (!exists) {
      await this.client.makeBucket(bucket);
    }
  }

  async uploadObject(
    objectName: string,
    content: Buffer,
    metadata?: ItemBucketMetadata,
    bucket = this.defaultBucket,
  ): Promise<void> {
    await this.ensureBucket(bucket);
    const finalMetadata = this.buildMetadata(metadata);

    await this.client.putObject(bucket, objectName, content, content.length, finalMetadata);
  }

  async downloadObject(
    objectName: string,
    bucket = this.defaultBucket,
  ): Promise<Buffer> {
    const stream = await this.client.getObject(bucket, objectName);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  private buildMetadata(metadata?: ItemBucketMetadata): ItemBucketMetadata | undefined {
    if (!this.enforceSse) {
      return metadata;
    }

    if (!this.sseAlgorithm) {
      throw new Error('SSE algorithm must be provided when enforceSse is enabled');
    }

    return {
      ...metadata,
      'x-amz-server-side-encryption': this.sseAlgorithm,
    };
  }
}

