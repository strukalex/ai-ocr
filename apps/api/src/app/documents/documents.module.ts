import { Module } from '@nestjs/common';
import { QueueModule } from '@my-org/queue';
import { CorrectionsController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { AuditLogger, TracingModule } from '@my-org/observability';

@Module({
  imports: [QueueModule, TracingModule],
  controllers: [DocumentsController, CorrectionsController],
  providers: [DocumentsService, CorrectionsService, AuditLogger],
})
export class DocumentsModule {}
