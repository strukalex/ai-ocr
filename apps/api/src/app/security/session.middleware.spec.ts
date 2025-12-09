import { createSessionTimeoutMiddleware } from './session.middleware';

const next = jest.fn();
const res = {
  status: jest.fn().mockReturnThis(),
  send: jest.fn(),
} as any;

function buildReq(auth?: string, now = Date.now()) {
  return {
    headers: auth ? { authorization: auth } : {},
    ip: '1.1.1.1',
    now,
  } as any;
}

describe('session timeout middleware', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    next.mockReset();
    res.status.mockClear();
    res.send.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows first request', () => {
    const mw = createSessionTimeoutMiddleware(30);
    mw(buildReq('token'), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('expires after idle period', () => {
    const mw = createSessionTimeoutMiddleware(1); // 1 minute
    mw(buildReq('token'), res, next);
    jest.setSystemTime(61 * 1000);
    mw(buildReq('token'), res, next);
    expect(res.status).toHaveBeenCalledWith(440);
    expect(res.send).toHaveBeenCalledWith('Session expired');
  });

  it('evicts expired entries during cleanup', () => {
    const mw: any = createSessionTimeoutMiddleware(1, { cleanupIntervalMs: 0 });

    mw(buildReq('tokenA'), res, next);
    expect(mw.__hasToken('tokenA')).toBe(true);

    jest.setSystemTime(61 * 1000);
    mw(buildReq('tokenB'), res, next);

    expect(mw.__hasToken('tokenA')).toBe(false);
    expect(mw.__hasToken('tokenB')).toBe(true);
    expect(mw.__getCacheSize()).toBe(1);
  });

  it('bounds the cache size by evicting oldest entries', () => {
    const mw: any = createSessionTimeoutMiddleware(5, { maxEntries: 3, cleanupIntervalMs: 0 });

    mw(buildReq('t1'), res, next);
    mw(buildReq('t2'), res, next);
    mw(buildReq('t3'), res, next);
    expect(mw.__getCacheSize()).toBe(3);

    mw(buildReq('t4'), res, next);

    expect(mw.__getCacheSize()).toBe(3);
    expect(mw.__hasToken('t1')).toBe(false); // oldest evicted
    expect(mw.__hasToken('t4')).toBe(true);
  });
});

