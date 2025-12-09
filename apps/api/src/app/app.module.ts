import { Module } from '@nestjs/common';
import { SecurityModule } from './security/security.module';
import { AuthModule } from './auth/auth.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule, PrismaService } from '@my-org/database';
import { AUDIT_SINKS } from '@my-org/observability';
import { PrismaAuditSink } from './audit/prisma-audit.sink';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestTelemetryInterceptor } from './telemetry/request-telemetry.interceptor';
import { DocumentsModule } from './documents/documents.module';
import { IntakeSourcesModule } from './intake-sources/intake-sources.module';
import { LearningModule } from './learning/learning.module';

@Module({
  imports: [
    SecurityModule,
    AuthModule,
    DatabaseModule,
    DocumentsModule,
    IntakeSourcesModule,
    LearningModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    PrismaAuditSink,
    {
      provide: AUDIT_SINKS,
      useFactory: (sink: PrismaAuditSink) => [sink],
      inject: [PrismaAuditSink],
    },
    PrismaService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestTelemetryInterceptor,
    },
  ],
})
export class AppModule {}
