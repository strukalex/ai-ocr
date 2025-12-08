import { LoggerService } from './logger.service';

describe('LoggerService', () => {
  it('emits JSON with message and level', () => {
    const logger = new LoggerService();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined as unknown as void);
    logger.info('hello', { traceId: 't1', spanId: 's1', service: 'test' });
    expect(spy).toHaveBeenCalled();
    const payload = JSON.parse((spy.mock.calls[0][0] as string) ?? '{}');
    expect(payload.message).toBe('hello');
    expect(payload.level).toBe('info');
    expect(payload.traceId).toBe('t1');
    expect(payload.service).toBe('test');
    spy.mockRestore();
  });
});

