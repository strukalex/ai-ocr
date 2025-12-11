import { Inject, Injectable, Optional } from '@nestjs/common';
import { LoggerService } from './logger.service';

export interface AuditRecord {
  action: string;
  actorId?: string;
  roles?: string[];
  resource?: string;
  outcome: 'success' | 'failure';
  traceId?: string;
  metadata?: Record<string, unknown>;
  documentId?: string;
}

export interface AuditSink {
  persist(event: AuditRecord): Promise<void>;
}

export const AUDIT_SINKS = 'AUDIT_SINKS';

@Injectable()
export class AuditLogger {
  constructor(
    private readonly logger: LoggerService,
    @Optional() @Inject(AUDIT_SINKS) private readonly sinks?: AuditSink[],
  ) {}

  async log(event: AuditRecord): Promise<void> {
    this.logger.info('audit', {
      action: event.action,
      actorId: event.actorId,
      roles: event.roles,
      resource: event.resource,
      outcome: event.outcome,
      traceId: event.traceId,
      documentId: event.documentId,
      metadata: event.metadata,
    });

    if (!this.sinks || this.sinks.length === 0) return;

    const results = await Promise.allSettled(this.sinks.map((sink) => sink.persist(event)));
    const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failures.length > 0) {
      this.logger.error('audit.persist_failed', {
        action: event.action,
        documentId: event.documentId,
        errors: failures.map((f) => String(f.reason ?? 'unknown')),
      });
      throw failures[0].reason ?? new Error('Audit sink failed');
    }
  }
}

