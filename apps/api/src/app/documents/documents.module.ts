import { Module } from '@nestjs/common';
import { QueueModule } from '@my-org/queue';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { AuditLogger, TracingModule } from '@my-org/observability';

@Module({
  imports: [QueueModule, TracingModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, AuditLogger],
})
export class DocumentsModule {}
