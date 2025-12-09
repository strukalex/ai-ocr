import { Module } from '@nestjs/common';
import { AuditLogger, TracingModule } from '@my-org/observability';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';

@Module({
  imports: [TracingModule],
  controllers: [LearningController],
  providers: [LearningService, AuditLogger],
})
export class LearningModule {}

