import { NextFunction, Request, Response } from 'express';

export function createSessionTimeoutMiddleware(sessionIdleMinutes: number) {
  const lastSeen = new Map<string, number>();
  const ttlMs = sessionIdleMinutes * 60 * 1000;

  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization ?? req.ip;
    const now = Date.now();
    const last = token ? lastSeen.get(token) ?? now : now;
    if (token && now - last > ttlMs) {
      res.status(440).send('Session expired');
      return;
    }
    if (token) lastSeen.set(token, now);
    next();
  };
}

