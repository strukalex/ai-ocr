import { Injectable } from '@nestjs/common';
import { PrismaService } from '@my-org/database';
import {
  DocumentIngestRequestDto,
  DocumentIngestResponseDto,
} from '@my-org/shared-types';
import { DocumentStatus } from '@my-org/shared-types';
import { Queue } from 'bullmq';
import { QueueService } from '@my-org/queue';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    queueService: QueueService,
  ) {
    this.intakeQueue = queueService.createQueue('intake');
  }

  private readonly intakeQueue: Queue;

  async ingest(request: DocumentIngestRequestDto): Promise<DocumentIngestResponseDto> {
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

    await this.intakeQueue.add('intake', {
      documentId: created.id,
      sourceChannel: request.sourceChannel,
      checksum: request.checksum,
      originalUri: request.originalUri,
      filename: request.filename,
      idempotencyKey: request.idempotencyKey,
      metadata: request.metadata,
    });

    return {
      documentId: created.id,
      status: created.status as DocumentStatus,
    };
  }
}
