import { Module } from '@nestjs/common';
import { SecurityModule } from './security/security.module';
import { AuthModule } from './auth/auth.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule, PrismaService } from '@my-org/database';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestTelemetryInterceptor } from './telemetry/request-telemetry.interceptor';
import { DocumentsModule } from './documents/documents.module';
import { IntakeSourcesModule } from './intake-sources/intake-sources.module';
import { LearningModule } from './learning/learning.module';
import { AuditModule } from './audit/audit.module';
import { BullBoardDashboardModule } from './queues/bull-board.module';

@Module({
  imports: [
    SecurityModule,
    AuthModule,
    DatabaseModule,
    AuditModule,
    DocumentsModule,
    IntakeSourcesModule,
    LearningModule,
    BullBoardDashboardModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    PrismaService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestTelemetryInterceptor,
    },
  ],
})
export class AppModule {}
