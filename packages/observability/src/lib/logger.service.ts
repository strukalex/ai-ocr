import { Injectable } from '@nestjs/common';

interface LogFields {
  traceId?: string;
  spanId?: string;
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
    const payload = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...fields,
    };
    // Ensure predictable JSON logs for tracing backends
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
  }
}

