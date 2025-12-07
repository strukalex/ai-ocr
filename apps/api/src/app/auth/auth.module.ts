import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditLogger, TracingModule } from '@my-org/observability';
import { AuditAuthGuard } from './audit-auth.guard';

@Module({
  imports: [TracingModule],
  providers: [
    AuditLogger,
    {
      provide: APP_GUARD,
      useClass: AuditAuthGuard,
    },
  ],
})
export class AuthModule {}

