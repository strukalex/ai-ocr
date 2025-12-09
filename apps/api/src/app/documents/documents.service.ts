import { Injectable } from '@nestjs/common';
import { PrismaService } from '@my-org/database';
import {
  DocumentIngestRequestDto,
  DocumentIngestResponseDto,
} from '@my-org/shared-types';
import { DocumentStatus } from '@my-org/shared-types';
import { Queue } from 'bullmq';
import { QueueService } from '@my-org/queue';
import { LoggerService } from '@my-org/observability';
import { context, trace } from '@opentelemetry/api';
import { randomUUID } from 'crypto';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly logger: LoggerService,
  ) {
    this.intakeQueue = queueService.createQueue('intake');
  }

  private readonly intakeQueue: Queue;

  async ingest(
    request: DocumentIngestRequestDto,
    actorId?: string,
    traceIdFromRequest?: string | string[],
  ): Promise<DocumentIngestResponseDto> {
    const created = await this.prisma.document.create({
      data: {
        sourceChannel: request.sourceChannel,
        originalUri: request.originalUri,
        canonicalUri: null,
        checksum: request.checksum,
        status: DocumentStatus.Uploaded,
        parentDocumentId: null,
        rootDocumentId: null,
      },
      select: { id: true, status: true },
    });

    await this.prisma.intakeRequest.create({
      data: {
        documentId: created.id,
        intakeSourceId: null,
        idempotencyKey: request.idempotencyKey ?? null,
        status: 'received',
      },
    });

    const activeSpan = trace.getSpan(context.active());
    const traceId =
      (Array.isArray(traceIdFromRequest) ? traceIdFromRequest[0] : traceIdFromRequest) ??
      activeSpan?.spanContext().traceId ??
      randomUUID().replace(/-/g, '');

    await this.queueService.enqueue(
      this.intakeQueue,
      'intake',
      {
        documentId: created.id,
        sourceChannel: request.sourceChannel,
        checksum: request.checksum,
        originalUri: request.originalUri,
        filename: request.filename,
        idempotencyKey: request.idempotencyKey,
        metadata: request.metadata,
        traceId,
      },
      {
        jobId: request.idempotencyKey ?? request.checksum,
      },
    );

    this.logger.info('ingestion.intake_enqueued', {
      documentId: created.id,
      checksum: request.checksum,
      idempotencyKey: request.idempotencyKey,
      sourceChannel: request.sourceChannel,
      traceId,
      user_id: actorId ?? 'unknown',
      actorId,
    });

    return {
      documentId: created.id,
      status: created.status as DocumentStatus,
    };
  }
}
