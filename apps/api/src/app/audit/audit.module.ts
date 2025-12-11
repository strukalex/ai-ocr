import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '@my-org/database';
import { AuditLogger, AUDIT_SINKS } from '@my-org/observability';
import { PrismaAuditSink } from './prisma-audit.sink';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    AuditLogger,
    PrismaAuditSink,
    {
      provide: AUDIT_SINKS,
      useFactory: (sink: PrismaAuditSink) => [sink],
      inject: [PrismaAuditSink],
    },
  ],
  exports: [AuditLogger, AUDIT_SINKS],
})
export class AuditModule {}

