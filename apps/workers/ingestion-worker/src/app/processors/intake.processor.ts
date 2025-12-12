import { Injectable } from '@nestjs/common';
import { PrismaService } from '@my-org/database';
import { AuditLogger, LoggerService } from '@my-org/observability';
import { DocumentStatus, SourceChannel } from '@my-org/shared-types';
import { QueueService } from '@my-org/queue';
import { StorageService } from '@my-org/storage';
import { Job, Queue } from 'bullmq';
import axios from 'axios';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { URL } from 'url';
import { PDFDocument } from 'pdf-lib';
import { NormalizationService } from '../services/normalization.service';
import { PreprocessingService } from '../services/preprocessing.service';
import { ClassifyJobPayload } from './classify.processor';

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
    private readonly preprocessing: PreprocessingService,
    private readonly normalization: NormalizationService,
    private readonly queueService: QueueService,
  ) {
    this.splitQueue = this.queueService.createQueue('split');
    this.classifyQueue = this.queueService.createQueue('classify');
  }

  private readonly splitQueue: Queue;
  private readonly classifyQueue: Queue;

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
    const parsedOriginal = this.parseDefaultBucketS3Uri(document.originalUri ?? payload.originalUri);
    const allowChecksumMismatch = process.env['ALLOW_CHECKSUM_MISMATCH'] === 'true';

    // Resolve and validate the original content before persisting.
    const originalBuffer = await this.loadOriginalBuffer(payload, traceId);
    const detectedOriginalChecksum = this.computeSha256(originalBuffer);
    const checksumToPersist = payload.checksum || detectedOriginalChecksum;
    const originalKey = parsedOriginal?.key ?? `originals/${checksumToPersist}`;
    const canonicalKey = `canonical/${checksumToPersist}.pdfa`;
    const storedOriginalUri = parsedOriginal?.uri ?? `s3://${bucket}/${originalKey}`;
    const originalUri = document.originalUri ?? storedOriginalUri;
    const canonicalUri = `s3://${bucket}/${canonicalKey}`;

    if (!originalBuffer || originalBuffer.length === 0) {
      await this.prisma.document.update({
        where: { id: payload.documentId },
        data: {
          status: DocumentStatus.Failed,
          stateReason: 'Original content unavailable',
        },
      });

      await this.audit.log({
        action: 'ingestion.intake_failed',
        actorId: 'system',
        outcome: 'failure',
        traceId,
        documentId: payload.documentId,
        metadata: {
          reason: 'missing_original',
          originalUri: payload.originalUri,
          sourceChannel: payload.sourceChannel,
        },
      });

      this.logger.warn('ingestion.intake_missing_content', {
        traceId,
        documentId: payload.documentId,
        originalUri: payload.originalUri,
        sourceChannel: payload.sourceChannel,
      });

      return;
    }

    if (payload.checksum && payload.checksum !== detectedOriginalChecksum) {
      const metadata = {
        traceId,
        documentId: payload.documentId,
        expected: payload.checksum,
        detected: detectedOriginalChecksum,
        sourceChannel: payload.sourceChannel,
      };

      this.logger.warn('ingestion.intake_checksum_mismatch', metadata);

      if (!allowChecksumMismatch) {
        await this.prisma.document.update({
          where: { id: payload.documentId },
          data: {
            status: DocumentStatus.Failed,
            stateReason: 'Checksum mismatch',
          },
        });

        await this.audit.log({
          action: 'ingestion.intake_failed',
          actorId: 'system',
          outcome: 'failure',
          traceId,
          documentId: payload.documentId,
          metadata: {
            reason: 'checksum_mismatch',
            expected: payload.checksum,
            detected: detectedOriginalChecksum,
            sourceChannel: payload.sourceChannel,
          },
        });

        return;
      }
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

    // Deskew/denoise/binarize images before PDF/A normalization when applicable.
    const contentType = this.inferContentType(payload.filename);
    let bufferForNormalization = originalBuffer;
    let preprocessingApplied = false;
    let correctionAngleDeg: number | null = null;

    let preprocessedKey: string | undefined;
    let preprocessedBucket: string | undefined;
    if (contentType?.startsWith('image/')) {
      try {
        const result = await this.preprocessing.preprocess({
          buffer: originalBuffer,
          bucket,
          sourceKey: originalKey,
          filename: payload.filename,
          traceId,
        });
        bufferForNormalization = result.buffer;
        preprocessingApplied = true;
        correctionAngleDeg = result.correctionAngleDeg;
        preprocessedKey = result.objectKey;
        preprocessedBucket = result.bucket;
      } catch (err) {
        this.logger.warn('ingestion.preprocessing_failed', {
          traceId,
          documentId: payload.documentId,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    // Create canonical artifact separately using PDF/A-2b conversion to keep originals immutable.
    const canonicalExists = await this.storage.objectExists(canonicalKey, bucket);
    let canonicalChecksum = checksumToPersist;
    let canonicalBuffer: Buffer | null = null;
    if (!canonicalExists) {
      canonicalBuffer = await this.normalization.toPdfA(bufferForNormalization, payload.filename);
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

    // Opportunistically enqueue split job when the document appears multi-part.
    const splitEnqueued = await this.shouldSplit(originalBuffer, canonicalBuffer ?? undefined);
    if (splitEnqueued) {
      await this.queueService.enqueue(
        this.splitQueue,
        'split',
        {
          documentId: payload.documentId,
          canonicalUri,
          originalUri,
          filename: payload.filename,
          sourceChannel: payload.sourceChannel as SourceChannel,
          traceId,
        },
        {
          // BullMQ disallows ':' in custom job ids; use dash separator.
          jobId: `${payload.documentId}-split`,
        },
      );

      this.logger.info('ingestion.split_enqueued', {
        documentId: payload.documentId,
        traceId,
        canonicalUri,
        originalUri,
      });
    }

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
        storedOriginalUri: storedOriginalUri,
        canonicalUri,
        canonicalChecksum,
        idempotencyKey: payload.idempotencyKey,
        sourceChannel: payload.sourceChannel,
        preprocessingApplied,
        correctionAngleDeg,
        preprocessedKey,
        preprocessedBucket,
      },
    });

    this.logger.info('ingestion.intake_processed', {
      traceId,
      documentId: payload.documentId,
      checksum: payload.checksum,
      sourceChannel: payload.sourceChannel,
      idempotencyKey: payload.idempotencyKey,
      storedOriginalUri: storedOriginalUri,
      canonicalUri,
    });

    if (!splitEnqueued) {
      await this.enqueueClassification(payload, traceId);
    }
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

    // http(s):// support for externally hosted documents
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      try {
        const response = await axios.get<ArrayBuffer>(uri, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
      } catch (err) {
        this.logger.warn('ingestion.intake_http_fetch_failed', {
          traceId,
          documentId: payload.documentId,
          originalUri: uri,
          error: (err as Error).message,
        });
        return Buffer.alloc(0);
      }
    }

    this.logger.warn('ingestion.intake_unhandled_uri_scheme', {
      traceId,
      documentId: payload.documentId,
      originalUri: uri,
    });
    return Buffer.alloc(0);
  }

  private parseDefaultBucketS3Uri(uri?: string): { key: string; uri: string } | null {
    if (!uri || !uri.startsWith('s3://')) {
      return null;
    }

    try {
      const parsed = new URL(uri);
      const bucket = parsed.hostname;
      if (bucket !== this.storage.getDefaultBucket()) {
        return null;
      }
      const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      return { key, uri: `s3://${bucket}/${key}` };
    } catch {
      return null;
    }
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

  private async shouldSplit(originalBuffer: Buffer, canonicalBuffer?: Buffer): Promise<boolean> {
    const candidate = canonicalBuffer ?? originalBuffer;
    if (!candidate || candidate.length === 0) return false;

    try {
      const pdf = await PDFDocument.load(candidate);
      return pdf.getPageCount() > 1;
    } catch {
      // Not a PDF; cannot split heuristically.
      return false;
    }
  }

  private async enqueueClassification(payload: IntakeJobPayload, traceId?: string): Promise<void> {
    const classifyPayload: ClassifyJobPayload = {
      documentId: payload.documentId,
      filename: payload.filename,
      metadata: payload.metadata,
      sourceChannel: payload.sourceChannel as SourceChannel,
      traceId,
    };

    try {
      await this.queueService.enqueue(
        this.classifyQueue,
        'classify',
        classifyPayload,
        {
          jobId: `${payload.documentId}-classify`,
        },
      );

      this.logger.info('ingestion.classify_enqueued', {
        documentId: payload.documentId,
        traceId,
        checksum: payload.checksum,
        sourceChannel: payload.sourceChannel,
      });
    } catch (error) {
      await this.prisma.document.update({
        where: { id: payload.documentId },
        data: { status: DocumentStatus.Failed, stateReason: 'Classify enqueue failed' },
      });

      await this.audit.log({
        action: 'ingestion.intake_failed',
        actorId: 'system',
        outcome: 'failure',
        traceId,
        documentId: payload.documentId,
        metadata: {
          reason: 'classify_enqueue_failed',
          error: (error as Error).message,
        },
      });

      this.logger.error('ingestion.intake_failed', {
        documentId: payload.documentId,
        traceId,
        error: (error as Error).message,
        stage: 'classify_enqueue',
      });

      throw error;
    }
  }
}

