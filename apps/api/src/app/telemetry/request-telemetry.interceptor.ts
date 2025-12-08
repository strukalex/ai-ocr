import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { context, trace } from '@opentelemetry/api';

@Injectable()
export class RequestTelemetryInterceptor implements NestInterceptor {
  private tracer = trace.getTracer('api');

  intercept(contextHost: ExecutionContext, next: CallHandler): Observable<any> {
    const http = contextHost.switchToHttp();
    const req = http.getRequest<Request>() as any;
    const span = this.tracer.startSpan('http.request', {
      attributes: {
        'http.method': req.method,
        'http.route': req.route?.path ?? req.url,
      },
    });

    return next.handle().pipe(
      tap({
        next: () => span.end(),
        error: (err) => {
          span.recordException(err as Error);
          span.setAttribute('http.status_code', err?.status ?? 500);
          span.end();
        },
      }),
    );
  }
}
