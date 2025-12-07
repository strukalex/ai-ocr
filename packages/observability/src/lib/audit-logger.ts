import { Injectable } from '@nestjs/common';
import { LoggerService } from './logger.service';

export interface AuditEvent {
  action: string;
  userId?: string;
  roles?: string[];
  outcome: 'success' | 'failure';
  traceId?: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class AuditLogger {
  constructor(private readonly logger: LoggerService) {}

  log(event: AuditEvent): void {
    this.logger.info('audit', {
      action: event.action,
      userId: event.userId,
      roles: event.roles,
      outcome: event.outcome,
      traceId: event.traceId,
      details: event.details,
    });
  }
}

