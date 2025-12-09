import { Module } from '@nestjs/common';
import { DatabaseModule } from '@my-org/database';
import { QueueModule } from '@my-org/queue';
import { StorageModule } from '@my-org/storage';
import { AuditLogger, TracingModule } from '@my-org/observability';
import { WatcherService } from './watcher.service';

@Module({
  imports: [DatabaseModule, QueueModule, StorageModule, TracingModule],
  providers: [AuditLogger, WatcherService],
  exports: [WatcherService],
})
export class IngestWatcherModule {}

