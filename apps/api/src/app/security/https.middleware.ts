import { NextFunction, Request, Response } from 'express';

/**
 * Enforces HTTPS (or trusted proxy header) when required by config.
 * Allows plain HTTP only when explicitly disabled (e.g., local dev).
 */
export function createHttpsEnforcementMiddleware(options: {
  requireTls: boolean;
  trustProxy: boolean;
}) {
  const { requireTls, trustProxy } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    if (!requireTls) return next();

    const isSecure = req.secure || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
    if (!isSecure) {
      res.status(400).send('HTTPS required');
      return;
    }

    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}
