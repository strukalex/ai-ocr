import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { IngestionWorkerModule } from './app/ingestion-worker.module';
import { QueueService } from '@my-org/queue';
import { IntakeProcessor } from './app/processors/intake.processor';
import { LoggerService } from '@my-org/observability';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(IngestionWorkerModule, {
    logger: false,
  });

  const queueService = app.get(QueueService);
  const intakeProcessor = app.get(IntakeProcessor);
  const logger = app.get(LoggerService);

  const concurrency = Number(process.env['INTAKE_WORKER_CONCURRENCY'] ?? 5);

  const worker: Worker = queueService.createWorker(
    'intake',
    (job) => intakeProcessor.handle(job),
    { concurrency },
  );

  worker.on('completed', (job) => {
    logger.info('ingestion.intake_completed', {
      documentId: job.data.documentId,
      traceId: job.data.traceId ?? job.id,
      jobId: job.id,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error('ingestion.intake_failed', {
      documentId: job?.data?.documentId,
      traceId: job?.data?.traceId ?? job?.id,
      error: err?.message,
      jobId: job?.id,
    });
  });

  logger.info('ingestion-worker.started', {
    service: 'ingestion-worker',
    queue: 'intake',
    concurrency,
  });
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

