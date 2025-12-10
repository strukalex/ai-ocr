import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { IntakeSource, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'crypto';
import { readFile, readdir, stat } from 'fs/promises';
import { watch } from 'fs';
import { basename, join } from 'path';
import { pathToFileURL } from 'url';
import { PrismaService } from '@my-org/database';
import { AuditLogger, LoggerService } from '@my-org/observability';
import { QueueService } from '@my-org/queue';
import { DocumentStatus, SourceChannel } from '@my-org/shared-types';
import { StorageService } from '@my-org/storage';

interface WatchHandle {
  stop: () => Promise<void>;
  sourceId: string;
}

interface PollHandle {
  sourceId: string;
  timer: NodeJS.Timeout;
}

@Injectable()
export class WatcherService implements OnModuleDestroy {
  private readonly intakeQueue: Queue;
  private readonly fileWatchers: WatchHandle[] = [];
  private readonly pollers: PollHandle[] = [];
  private readonly seenKeys = new Set<string>();
  private activeSources = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly storage: StorageService,
    private readonly logger: LoggerService,
    private readonly audit: AuditLogger,
  ) {
    this.intakeQueue = this.queueService.createQueue('intake');
  }

  async start(): Promise<void> {
    const sources = await this.prisma.intakeSource.findMany({
      where: { active: true, type: SourceChannel.WatchedStorage },
    });

    this.activeSources = sources.length;

    await Promise.all(sources.map((source) => this.registerSource(source)));
  }

  getActiveSourceCount(): number {
    return this.activeSources;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      this.fileWatchers.map((watcher) =>
        watcher.stop().catch((err) =>
          this.logger.warn('ingest-watcher.stop_failed', {
            sourceId: watcher.sourceId,
            error: err instanceof Error ? err.message : 'unknown',
          }),
        ),
      ),
    );

    this.pollers.forEach((poller) => clearInterval(poller.timer));
  }

  private async registerSource(source: IntakeSource): Promise<void> {
    try {
      const parsed = new URL(source.uri);

      if (parsed.protocol === 'file:') {
        await this.startFileWatcher(source, parsed);
        return;
      }

      if (parsed.protocol === 'smb:') {
        const normalized = new URL(`file://${parsed.host}${parsed.pathname}`);
        await this.startFileWatcher(source, normalized);
        return;
      }

      if (parsed.protocol === 's3:') {
        await this.startS3Poller(source, parsed);
        return;
      }

      this.logger.warn('ingest-watcher.unsupported_protocol', {
        sourceId: source.id,
        uri: source.uri,
        protocol: parsed.protocol,
      });
    } catch (err) {
      this.logger.error('ingest-watcher.invalid_source_uri', {
        sourceId: source.id,
        uri: source.uri,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  private async startFileWatcher(source: IntakeSource, uri: URL): Promise<void> {
    const directoryPath = decodeURIComponent(uri.pathname);

    try {
      const stats = await stat(directoryPath);
      if (!stats.isDirectory()) {
        this.logger.warn('ingest-watcher.path_not_directory', {
          sourceId: source.id,
          uri: source.uri,
          path: directoryPath,
        });
        return;
      }
    } catch (err) {
      this.logger.warn('ingest-watcher.path_unavailable', {
        sourceId: source.id,
        uri: source.uri,
        path: directoryPath,
        error: err instanceof Error ? err.message : 'unknown',
      });
      return;
    }

    await this.processExistingFiles(directoryPath, source);

    const watcher = watch(
      directoryPath,
      { recursive: true, persistent: true },
      (eventType, filename) => {
        if (!filename) return;
        if (eventType === 'rename' || eventType === 'change') {
          const fullPath = join(directoryPath, filename);
          this.handleFile(fullPath, source).catch((err) => {
            this.logger.warn('ingest-watcher.file_event_failed', {
              sourceId: source.id,
              uri: source.uri,
              file: fullPath,
              error: err instanceof Error ? err.message : 'unknown',
            });
          });
        }
      },
    );

    this.fileWatchers.push({
      sourceId: source.id,
      stop: async () => watcher.close(),
    });

    this.logger.info('ingest-watcher.watch_started', {
      sourceId: source.id,
      uri: source.uri,
      path: directoryPath,
    });
  }

  private async startS3Poller(source: IntakeSource, uri: URL): Promise<void> {
    const bucket = uri.hostname;
    const prefix = decodeURIComponent(uri.pathname.replace(/^\/+/, ''));
    const intervalMs = Math.max(5, source.pollingIntervalSeconds ?? 30) * 1000;

    const pollOnce = async (): Promise<void> => {
      try {
        const keys = await this.storage.listObjects(prefix, bucket);
        for (const key of keys) {
          const seenKey = `${source.id}:${key}`;
          if (this.seenKeys.has(seenKey)) continue;
          this.seenKeys.add(seenKey);

          const buffer = await this.storage.downloadObject(key, bucket);
          await this.handleBuffer(source, buffer, `s3://${bucket}/${key}`, basename(key));
        }
      } catch (err) {
        this.logger.warn('ingest-watcher.s3_poll_failed', {
          sourceId: source.id,
          uri: source.uri,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    };

    await pollOnce();
    const timer = setInterval(() => {
      pollOnce().catch((err) =>
        this.logger.warn('ingest-watcher.s3_poll_failed', {
          sourceId: source.id,
          uri: source.uri,
          error: err instanceof Error ? err.message : 'unknown',
        }),
      );
    }, intervalMs);

    this.pollers.push({ sourceId: source.id, timer });

    this.logger.info('ingest-watcher.poller_started', {
      sourceId: source.id,
      uri: source.uri,
      bucket,
      prefix,
      intervalMs,
    });
  }

  private async processExistingFiles(directory: string, source: IntakeSource): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await this.processExistingFiles(fullPath, source);
          return;
        }
        if (entry.isFile()) {
          await this.handleFile(fullPath, source);
        }
      }),
    );
  }

  private async handleFile(fullPath: string, source: IntakeSource): Promise<void> {
    try {
      const fileStat = await stat(fullPath);
      if (!fileStat.isFile()) return;
    } catch {
      // file might have been moved/deleted before we could read it
      return;
    }

    const buffer = await readFile(fullPath);
    const originalUri = pathToFileURL(fullPath).toString();
    await this.handleBuffer(source, buffer, originalUri, basename(fullPath));
  }

  private async handleBuffer(
    source: IntakeSource,
    buffer: Buffer,
    originalUri: string,
    filename: string,
  ): Promise<void> {
    const checksum = this.computeSha256(buffer);

    const existing = await this.prisma.document.findFirst({
      where: { checksum },
      select: { id: true, status: true },
    });

    if (existing) {
      this.logger.info('ingest-watcher.dedup', {
        sourceId: source.id,
        uri: source.uri,
        checksum,
        documentId: existing.id,
      });
      return;
    }

    try {
      const created = await this.prisma.document.create({
        data: {
          sourceChannel: SourceChannel.WatchedStorage,
          originalUri,
          canonicalUri: null,
          checksum,
          status: DocumentStatus.Uploaded,
        } satisfies Prisma.DocumentCreateInput,
        select: { id: true, status: true },
      });

      await this.prisma.intakeRequest.create({
        data: {
          documentId: created.id,
          intakeSourceId: source.id,
          idempotencyKey: checksum,
          status: 'received',
        },
      });

      const traceId = randomUUID().replace(/-/g, '');

      await this.queueService.enqueue(
        this.intakeQueue,
        'intake',
        {
          documentId: created.id,
          sourceChannel: SourceChannel.WatchedStorage,
          checksum,
          originalUri,
          filename,
          idempotencyKey: checksum,
          metadata: { intakeSourceId: source.id },
          traceId,
        },
        {
          jobId: checksum,
        },
      );

      await this.audit.log({
        action: 'ingestion.watched_storage_enqueued',
        actorId: 'system',
        outcome: 'success',
        traceId,
        documentId: created.id,
        metadata: {
          checksum,
          sourceId: source.id,
          uri: source.uri,
          originalUri,
        },
      });

      this.logger.info('ingest-watcher.enqueued', {
        sourceId: source.id,
        uri: source.uri,
        documentId: created.id,
        checksum,
        traceId,
      });

      this.seenKeys.add(checksum);
    } catch (err) {
      if (this.isUniqueConstraintError(err)) {
        this.logger.info('ingest-watcher.dedup', {
          sourceId: source.id,
          uri: source.uri,
          checksum,
        });
        return;
      }
      throw err;
    }
  }

  private computeSha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}

