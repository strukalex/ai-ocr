import { Module } from '@nestjs/common';
import { DatabaseModule } from '@my-org/database';
import { QueueModule } from '@my-org/queue';
import { StorageModule } from '@my-org/storage';
import { AuditLogger, TracingModule } from '@my-org/observability';
import { IntakeProcessor } from './processors/intake.processor';
import { NormalizationService } from './services/normalization.service';
import { PreprocessingService } from './services/preprocessing.service';
import { SplitProcessor } from './processors/split.processor';
import { ClassifyProcessor } from './processors/classify.processor';
import { WorkerAuthService } from './auth/worker-auth.service';

@Module({
  imports: [DatabaseModule, QueueModule, StorageModule, TracingModule],
  providers: [
    AuditLogger,
    NormalizationService,
    PreprocessingService,
    IntakeProcessor,
    SplitProcessor,
    ClassifyProcessor,
    WorkerAuthService,
  ],
  exports: [IntakeProcessor, SplitProcessor, PreprocessingService, ClassifyProcessor, WorkerAuthService],
})
export class IngestionWorkerModule {}

