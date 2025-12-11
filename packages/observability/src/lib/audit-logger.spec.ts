import { AuditLogger, AUDIT_SINKS, AuditRecord } from './audit-logger';
import { LoggerService } from './logger.service';

describe('AuditLogger', () => {
  const logger = {
    info: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;

  const sink = {
    persist: jest.fn().mockResolvedValue(undefined),
  };

  const record: AuditRecord = {
    action: 'test.action',
    actorId: 'user-1',
    outcome: 'success',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs to console logger by default', async () => {
    const audit = new AuditLogger(logger);
    await audit.log(record);
    expect(logger.info).toHaveBeenCalledWith(
      'audit',
      expect.objectContaining({ action: 'test.action', actorId: 'user-1', outcome: 'success' }),
    );
  });

  it('forwards to configured sinks', async () => {
    const audit = new AuditLogger(logger, [sink]);
    await audit.log(record);
    expect(sink.persist).toHaveBeenCalledWith(record);
  });

  it('throws and logs when sinks fail', async () => {
    const failingSink = { persist: jest.fn().mockRejectedValue(new Error('boom')) };
    const audit = new AuditLogger(logger, [failingSink]);
    await expect(audit.log(record)).rejects.toThrow('boom');
    expect(logger.error).toHaveBeenCalled();
  });
});
