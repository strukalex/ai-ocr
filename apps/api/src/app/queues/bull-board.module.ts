import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { AuditLogger } from '@my-org/observability';
import { QueueModule, QueueModuleOptions, QUEUE_OPTIONS_TOKEN } from '@my-org/queue';

const QUEUE_NAMES = ['intake', 'split', 'classify'] as const;

function isLoopback(req: any): boolean {
  const ip = (req.ip as string | undefined)?.replace('::ffff:', '') ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function createBullBoardAuthMiddleware(
  authService: AuthService,
  auditLogger: AuditLogger,
): (req: any, res: any, next: () => void) => Promise<void> {
  return async (req, res, next) => {
    const allowLocalBypass = process.env['BULL_BOARD_ALLOW_LOCAL'] === 'true' && isLoopback(req);
    if (allowLocalBypass) {
      return next();
    }
    try {
      const user = await authService.verify(req.headers.authorization);
      if (!user.roles?.includes('admin')) {
        await auditLogger.log({
          action: 'bull-board.access',
          actorId: user.userId,
          roles: user.roles,
          resource: req.originalUrl,
          outcome: 'failure',
          metadata: { reason: 'forbidden' },
        });
        res.status(403).json({ statusCode: 403, message: 'Forbidden' });
        return;
      }

      await auditLogger.log({
        action: 'bull-board.access',
        actorId: user.userId,
        roles: user.roles,
        resource: req.originalUrl,
        outcome: 'success',
      });
      req.user = user;
      next();
    } catch (err) {
      await auditLogger.log({
        action: 'bull-board.access',
        actorId: 'unknown',
        roles: [],
        resource: req.originalUrl,
        outcome: 'failure',
        metadata: { reason: 'unauthorized', error: err instanceof Error ? err.message : err },
      });
      res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
    }
  };
}

@Module({
  imports: [
    QueueModule,
    BullModule.forRootAsync({
      imports: [QueueModule],
      inject: [QUEUE_OPTIONS_TOKEN],
      useFactory: (options: QueueModuleOptions) => ({
        connection: {
          url: options.redisUrl ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379',
        },
        prefix: options.queuePrefix ?? 'bull',
      }),
    }),
    BullModule.registerQueue(
      ...QUEUE_NAMES.map((name) => ({ name })),
    ),
    BullBoardModule.forRootAsync({
      imports: [AuthModule],
      inject: [AuthService, AuditLogger],
      useFactory: (authService: AuthService, auditLogger: AuditLogger) => ({
        route: '/admin/queues',
        adapter: ExpressAdapter,
        middleware: createBullBoardAuthMiddleware(authService, auditLogger),
      }),
    }),
    BullBoardModule.forFeature(
      ...QUEUE_NAMES.map((name) => ({
        name,
        adapter: BullMQAdapter,
      })),
    ),
  ],
})
export class BullBoardDashboardModule {}


