import { Module } from '@nestjs/common';
import { TracingModule } from '@my-org/observability';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TracingModule, AuditModule],
  controllers: [LearningController],
  providers: [LearningService],
})
export class LearningModule {}

