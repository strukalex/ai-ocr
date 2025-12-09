import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

let sdk: NodeSDK | undefined;
let meterProvider: MeterProvider | undefined;

export async function initTelemetry(serviceName: string): Promise<void> {
  if (sdk) return;

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
  });

  const traceExporter = new OTLPTraceExporter({
    url: process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
      ? `${process.env['OTEL_EXPORTER_OTLP_ENDPOINT']}/v1/traces`
      : undefined,
  });

  const metricExporter = new OTLPMetricExporter({
    url: process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
      ? `${process.env['OTEL_EXPORTER_OTLP_ENDPOINT']}/v1/metrics`
      : undefined,
  });

  meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: metricExporter })],
  });

  sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  try {
    await sdk.start();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to start telemetry', err);
    sdk = undefined;
    meterProvider = undefined;
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  await meterProvider?.shutdown().catch(() => undefined);
  await sdk.shutdown().catch(() => undefined);
  sdk = undefined;
}

