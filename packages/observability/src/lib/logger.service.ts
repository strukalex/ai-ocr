import { Injectable } from '@nestjs/common';
import { context, trace } from '@opentelemetry/api';

interface LogFields {
  traceId?: string;
  spanId?: string;
  service?: string;
  [key: string]: unknown;
}

@Injectable()
export class LoggerService {
  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write('error', message, fields);
  }

  debug(message: string, fields: LogFields = {}): void {
    this.write('debug', message, fields);
  }

  private write(level: string, message: string, fields: LogFields): void {
    const span = trace.getSpan(context.active());
    const spanContext = span?.spanContext();
    const payload = {
      level,
      message,
      timestamp: new Date().toISOString(),
      service: fields.service ?? process.env['OTEL_SERVICE_NAME'] ?? 'unknown',
      traceId: fields.traceId ?? spanContext?.traceId,
      spanId: fields.spanId ?? spanContext?.spanId,
      ...fields,
    };
    // Ensure predictable JSON logs for tracing backends
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
  }
}

