import { Injectable } from '@nestjs/common';
import { PrismaService } from '@my-org/database';
import { AuditRecord, AuditSink } from '@my-org/observability';
import { Prisma } from '@prisma/client';

@Injectable()
export class PrismaAuditSink implements AuditSink {
  constructor(private readonly prisma: PrismaService) {}

  async persist(event: AuditRecord): Promise<void> {
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
  }
}
