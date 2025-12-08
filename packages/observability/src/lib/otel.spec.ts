import { initTelemetry, shutdownTelemetry } from './otel';

describe('otel bootstrap', () => {
  it('initializes without throwing', async () => {
    initTelemetry('test-service');
    await shutdownTelemetry();
  });
});

