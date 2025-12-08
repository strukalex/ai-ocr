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
});

