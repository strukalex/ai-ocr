import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { context, trace } from '@opentelemetry/api';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

@Injectable()
export class RequestTelemetryInterceptor implements NestInterceptor {
  private tracer = trace.getTracer('api');

  intercept(contextHost: ExecutionContext, next: CallHandler): Observable<any> {
    const http = contextHost.switchToHttp();
    const req = http.getRequest<Request>() as any;
    const res = http.getResponse<Response>() as any;
    const span = this.tracer.startSpan('http.request', {
      attributes: {
        'http.method': req.method,
        'http.route': req.route?.path ?? req.url,
      },
    });
    const spanContext = span.spanContext();
    const traceId =
      spanContext?.traceId && spanContext.traceId !== '00000000000000000000000000000000'
        ? spanContext.traceId
        : randomUUID().replace(/-/g, '');
    const spanId =
      spanContext?.spanId && spanContext.spanId !== '0000000000000000'
        ? spanContext.spanId
        : randomUUID().replace(/-/g, '').slice(0, 16);

    res.setHeader('trace-id', traceId);
    res.setHeader('traceparent', `00-${traceId}-${spanId}-01`);
    (req as any).traceId = traceId;

    return context.with(trace.setSpan(context.active(), span), () =>
      next.handle().pipe(
        tap({
          next: () => span.end(),
          error: (err) => {
            span.recordException(err as Error);
            span.setAttribute('http.status_code', err?.status ?? 500);
            span.end();
          },
        }),
      ),
    );
  }
}
