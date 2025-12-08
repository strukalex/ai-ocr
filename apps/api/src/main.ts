/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { SecurityConfigService } from './app/security/security.service';
import { NextFunction, Request, Response } from 'express';
import { initTelemetry, shutdownTelemetry } from '@my-org/observability';
import * as fs from 'fs';
import { loadTlsConfig } from './config/tls.config';
import { createSessionTimeoutMiddleware } from './app/security/session.middleware';

async function bootstrap() {
  initTelemetry(process.env['OTEL_SERVICE_NAME'] ?? 'ai-ocr-api');

  const { certFile, keyFile } = loadTlsConfig();
  const httpsOptions =
    certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile)
      ? {
          httpsOptions: {
            cert: fs.readFileSync(certFile),
            key: fs.readFileSync(keyFile),
          },
        }
      : undefined;

  const app = await NestFactory.create(AppModule, httpsOptions);
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  const securityConfig = app.get(SecurityConfigService);
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader(
      'X-Session-Timeout-Minutes',
      securityConfig.config.sessionTimeoutMinutes.toString(),
    );
    next();
  });
  const port = Number(process.env.PORT) || 3000;
  const sessionIdleMinutes = Number(process.env.SESSION_IDLE_MINUTES ?? 30);
  app.use(createSessionTimeoutMiddleware(sessionIdleMinutes));

  await app.listen(port);

  Logger.log(`🚀 Application is running on port ${port}/${globalPrefix}`);

  process.on('SIGTERM', async () => {
    await shutdownTelemetry();
    await app.close();
  });
}

bootstrap();
