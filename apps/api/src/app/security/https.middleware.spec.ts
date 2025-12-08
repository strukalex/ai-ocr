import { createHttpsEnforcementMiddleware } from './https.middleware';

describe('createHttpsEnforcementMiddleware', () => {
  const next = jest.fn();
  const res: any = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
    setHeader: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks plain HTTP when TLS is required', () => {
    const middleware = createHttpsEnforcementMiddleware({ requireTls: true, trustProxy: false });
    const req: any = { secure: false, headers: {} };

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('HTTPS required');
    expect(next).not.toHaveBeenCalled();
  });

  it('allows HTTPS with proxy header when trusted', () => {
    const middleware = createHttpsEnforcementMiddleware({ requireTls: true, trustProxy: true });
    const req: any = { secure: false, headers: { 'x-forwarded-proto': 'https' } };

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
