import { initTelemetry, shutdownTelemetry } from './otel';

describe('otel bootstrap', () => {
  it('initializes without throwing', async () => {
    await initTelemetry('test-service');
    await shutdownTelemetry();
  });
});

