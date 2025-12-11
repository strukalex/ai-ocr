/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app/app.module';
import { SecurityConfigService } from './app/security/security.service';
import { NextFunction, Request, Response } from 'express';
import { initTelemetry, shutdownTelemetry } from '@my-org/observability';
import * as fs from 'fs';
import { loadTlsConfig } from './config/tls.config';
import { createSessionTimeoutMiddleware } from './app/security/session.middleware';
import { createHttpsEnforcementMiddleware } from './app/security/https.middleware';
import { json, urlencoded } from 'express';

async function bootstrap() {
  await initTelemetry(process.env['OTEL_SERVICE_NAME'] ?? 'ai-ocr-api');

  const { certFile, keyFile } = loadTlsConfig();
  const httpsOptions =
    certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile)
      ? {
          cert: fs.readFileSync(certFile),
          key: fs.readFileSync(keyFile),
        }
      : undefined;

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    httpsOptions,
  });
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  // Allow larger payloads for inline content uploads (e.g., base64 bodies).
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  const securityConfig = app.get(SecurityConfigService);
  if (securityConfig.config.trustProxy) {
    app.set('trust proxy', 1);
  }

  app.use(
    createHttpsEnforcementMiddleware({
      requireTls: securityConfig.config.requireTls,
      trustProxy: securityConfig.config.trustProxy,
    }),
  );

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      'X-Session-Timeout-Minutes',
      securityConfig.config.sessionTimeoutMinutes.toString(),
    );
    next();
  });
  const port = Number(process.env.PORT) || 3000;
  const sessionIdleMinutes = securityConfig.config.sessionTimeoutMinutes;
  app.use(createSessionTimeoutMiddleware(sessionIdleMinutes));

  await app.listen(port);

  Logger.log(`🚀 Application is running on port ${port}/${globalPrefix}`);

  process.on('SIGTERM', async () => {
    await shutdownTelemetry();
    await app.close();
  });
}

bootstrap().catch((err) => {
  Logger.error('Failed to bootstrap application', err);
  void shutdownTelemetry();
  process.exit(1);
});
