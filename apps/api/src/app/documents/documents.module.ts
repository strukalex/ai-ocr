import { Module } from '@nestjs/common';
import { QueueModule } from '@my-org/queue';
import { CorrectionsController } from './corrections.controller';
import { CorrectionsService } from './corrections.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { TracingModule } from '@my-org/observability';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [QueueModule, TracingModule, AuditModule],
  controllers: [DocumentsController, CorrectionsController],
  providers: [DocumentsService, CorrectionsService],
})
export class DocumentsModule {}
