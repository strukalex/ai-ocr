import { Injectable } from '@nestjs/common';
import { PrismaService } from '@my-org/database';
import { AuditRecord, AuditSink, LoggerService } from '@my-org/observability';
import { Prisma } from '@prisma/client';

@Injectable()
export class PrismaAuditSink implements AuditSink {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  async persist(event: AuditRecord): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          documentId: event.documentId ?? null,
          actorId: event.actorId,
          action: event.action,
          resource: event.resource,
          outcome: event.outcome,
          traceId: event.traceId,
          metadata:
            (event.metadata as Prisma.InputJsonValue | undefined) ??
            Prisma.JsonNull,
        },
      });
      this.logger.info('audit.persisted', {
        action: event.action,
        documentId: event.documentId,
        traceId: event.traceId,
      });
    } catch (err) {
      this.logger.error('audit.persist_failed', {
        action: event.action,
        documentId: event.documentId,
        traceId: event.traceId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
