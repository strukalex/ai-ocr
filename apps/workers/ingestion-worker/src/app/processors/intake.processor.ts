import { Injectable } from '@nestjs/common';
import { PrismaService } from '@my-org/database';
import { AuditLogger, LoggerService } from '@my-org/observability';
import { DocumentStatus } from '@my-org/shared-types';
import { StorageService } from '@my-org/storage';
import { Job } from 'bullmq';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { URL } from 'url';
import { NormalizationService } from '../services/normalization.service';

export interface IntakeJobPayload {
  documentId: string;
  checksum: string;
  originalUri: string;
  filename?: string;
  idempotencyKey?: string | null;
  sourceChannel?: string;
  metadata?: Record<string, unknown>;
  traceId?: string;
}

@Injectable()
export class IntakeProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogger,
    private readonly logger: LoggerService,
    private readonly storage: StorageService,
    private readonly normalization: NormalizationService,
  ) {}

  async handle(job: Job<IntakeJobPayload>): Promise<void> {
    const payload = job.data;
    const traceId = payload.traceId ?? job.id?.toString();

    const document = await this.prisma.document.findUnique({
      where: { id: payload.documentId },
    });

    if (!document) {
      this.logger.warn('ingestion.intake_missing_document', {
        traceId,
        documentId: payload.documentId,
        checksum: payload.checksum,
      });
      return;
    }

    const bucket = this.storage.getDefaultBucket();
    const originalKey = `originals/${payload.checksum}`;
    const canonicalKey = `canonical/${payload.checksum}.pdfa`;
    const originalUri = document.originalUri ?? `s3://${bucket}/${originalKey}`;
    const canonicalUri = `s3://${bucket}/${canonicalKey}`;

    // Resolve and validate the original content before persisting.
    const originalBuffer = await this.loadOriginalBuffer(payload, traceId);
    const detectedOriginalChecksum = this.computeSha256(originalBuffer);
    const checksumToPersist = payload.checksum || detectedOriginalChecksum;

    if (payload.checksum && payload.checksum !== detectedOriginalChecksum) {
      this.logger.warn('ingestion.intake_checksum_mismatch', {
        traceId,
        documentId: payload.documentId,
        expected: payload.checksum,
        detected: detectedOriginalChecksum,
        sourceChannel: payload.sourceChannel,
      });
    }

    // Preserve original immutably and dedupe by checksum.
    const originalExists = await this.storage.objectExists(originalKey, bucket);
    if (!originalExists) {
      await this.storage.uploadObject(
        originalKey,
        originalBuffer,
        {
          'checksum-sha256': checksumToPersist,
          'source-uri': payload.originalUri ?? '',
          'content-type': this.inferContentType(payload.filename) ?? 'application/octet-stream',
        },
        bucket,
      );
    }

    // Create canonical artifact separately using PDF/A-2b conversion to keep originals immutable.
    const canonicalExists = await this.storage.objectExists(canonicalKey, bucket);
    let canonicalChecksum = checksumToPersist;
    if (!canonicalExists) {
      const canonicalBuffer = await this.normalization.toPdfA(originalBuffer, payload.filename);
      canonicalChecksum = this.computeSha256(canonicalBuffer);

      await this.storage.uploadObject(
        canonicalKey,
        canonicalBuffer,
        {
          'checksum-sha256': canonicalChecksum,
          'source-uri': payload.originalUri ?? '',
          'content-type': 'application/pdf',
          'canonical-of': checksumToPersist,
        },
        bucket,
      );
    }

    await this.prisma.document.update({
      where: { id: payload.documentId },
      data: {
        status: DocumentStatus.Uploaded,
        stateReason: null,
        originalUri,
        canonicalUri,
      },
    });

    await this.prisma.intakeRequest.updateMany({
      where: { documentId: payload.documentId },
      data: { status: 'processed' },
    });

    await this.audit.log({
      action: 'ingestion.intake_processed',
      actorId: 'system',
      outcome: 'success',
      traceId,
      documentId: payload.documentId,
      metadata: {
        checksum: payload.checksum,
        originalUri: payload.originalUri,
        storedOriginalUri: originalUri,
        canonicalUri,
        canonicalChecksum,
        idempotencyKey: payload.idempotencyKey,
        sourceChannel: payload.sourceChannel,
      },
    });

    this.logger.info('ingestion.intake_processed', {
      traceId,
      documentId: payload.documentId,
      checksum: payload.checksum,
      sourceChannel: payload.sourceChannel,
      idempotencyKey: payload.idempotencyKey,
      storedOriginalUri: originalUri,
      canonicalUri,
    });
  }

  private async loadOriginalBuffer(payload: IntakeJobPayload, traceId?: string): Promise<Buffer> {
    // Allow tests or callers to supply inline content.
    const rawContent = (payload.metadata as any)?.rawContentBase64 as string | undefined;
    if (rawContent) {
      return Buffer.from(rawContent, 'base64');
    }

    const uri = payload.originalUri;
    if (!uri) {
      this.logger.warn('ingestion.intake_missing_original_uri', {
        traceId,
        documentId: payload.documentId,
      });
      return Buffer.alloc(0);
    }

    // file:// or absolute path support
    if (uri.startsWith('file://') || uri.startsWith('/')) {
      try {
        const path = uri.startsWith('file://') ? new URL(uri).pathname : uri;
        return await readFile(path);
      } catch (err) {
        this.logger.warn('ingestion.intake_read_failed', {
          traceId,
          documentId: payload.documentId,
          originalUri: uri,
          error: (err as Error).message,
        });
        return Buffer.alloc(0);
      }
    }

    // s3://bucket/key support when targeting our default bucket
    if (uri.startsWith('s3://')) {
      try {
        const parsed = new URL(uri);
        const bucket = parsed.hostname;
        const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
        if (bucket === this.storage.getDefaultBucket()) {
          return await this.storage.downloadObject(key, bucket);
        }
      } catch (err) {
        this.logger.warn('ingestion.intake_s3_fetch_failed', {
          traceId,
          documentId: payload.documentId,
          originalUri: uri,
          error: (err as Error).message,
        });
      }
    }

    this.logger.warn('ingestion.intake_unhandled_uri_scheme', {
      traceId,
      documentId: payload.documentId,
      originalUri: uri,
    });
    return Buffer.alloc(0);
  }

  private computeSha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private inferContentType(filename?: string): string | undefined {
    if (!filename) return undefined;
    const ext = extname(filename).toLowerCase();
    switch (ext) {
      case '.pdf':
        return 'application/pdf';
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.tif':
      case '.tiff':
        return 'image/tiff';
      default:
        return undefined;
    }
  }
}

