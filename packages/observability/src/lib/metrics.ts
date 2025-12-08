import { Meter } from '@opentelemetry/api';
import { metrics } from '@opentelemetry/api';

const meter: Meter = metrics.getMeter('ai-ocr-meter');

export const queueDepthGauge = meter.createUpDownCounter('queue.depth', {
  description: 'Current queue depth',
});

export const queueLatencyHistogram = meter.createHistogram('queue.latency.ms', {
  description: 'Queue processing latency in ms',
});

