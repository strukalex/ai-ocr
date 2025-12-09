import { Module } from '@nestjs/common';
import { DatabaseModule } from '@my-org/database';
import { QueueModule } from '@my-org/queue';
import { StorageModule } from '@my-org/storage';
import { AuditLogger, TracingModule } from '@my-org/observability';
import { IntakeProcessor } from './processors/intake.processor';
import { NormalizationService } from './services/normalization.service';

@Module({
  imports: [DatabaseModule, QueueModule, StorageModule, TracingModule],
  providers: [AuditLogger, NormalizationService, IntakeProcessor],
  exports: [IntakeProcessor],
})
export class IngestionWorkerModule {}

