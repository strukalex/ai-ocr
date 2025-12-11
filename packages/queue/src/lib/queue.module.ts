import { Module } from '@nestjs/common';
import { QueueService, QueueModuleOptions } from './queue.service';
import { QUEUE_OPTIONS_TOKEN } from './queue.tokens';

@Module({
  providers: [
    {
      provide: QUEUE_OPTIONS_TOKEN,
      useFactory: (): QueueModuleOptions => ({
        redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
        queuePrefix: process.env['QUEUE_PREFIX'],
      }),
    },
    QueueService,
  ],
  exports: [QueueService, QUEUE_OPTIONS_TOKEN],
})
export class QueueModule {}

