import { NestFactory } from '@nestjs/core';
import { LoggerService } from '@my-org/observability';
import { IngestWatcherModule } from './app/ingest-watcher.module';
import { WatcherService } from './app/watcher.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(IngestWatcherModule, {
    logger: false,
  });

  const watcher = app.get(WatcherService);
  const logger = app.get(LoggerService);

  await watcher.start();

  logger.info('ingest-watcher.started', {
    service: 'ingest-watcher',
    sourceCount: watcher.getActiveSourceCount(),
  });
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

