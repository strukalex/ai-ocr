import { NextFunction, Request, Response } from 'express';

/**
 * Simple in-memory idle timeout guard with bounded memory.
 * Production setups should rely on short-lived tokens at the identity provider
 * plus this guard for defense in depth.
 */
interface SessionTimeoutOptions {
  /**
   * Maximum entries retained in-memory; oldest entries are evicted when exceeded.
   */
  maxEntries?: number;
  /**
   * Minimum time between cleanup passes (ms). Cleanup removes expired and excess entries.
   */
  cleanupIntervalMs?: number;
}

export function createSessionTimeoutMiddleware(
  sessionIdleMinutes: number,
  options: SessionTimeoutOptions = {},
) {
  const lastSeen = new Map<string, number>();
  const ttlMs = sessionIdleMinutes * 60 * 1000;
  const maxEntries = options.maxEntries ?? 5000;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? Math.max(ttlMs, 5 * 60 * 1000);
  let lastCleanup = 0;

  const trimOldest = (count: number) => {
    if (count <= 0) return;
    const oldest = Array.from(lastSeen.entries()).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < count && i < oldest.length; i++) {
      const [token] = oldest[i];
      lastSeen.delete(token);
    }
  };

  const cleanup = (now: number) => {
    if (now - lastCleanup < cleanupIntervalMs) return;

    for (const [token, ts] of lastSeen) {
      if (now - ts > ttlMs) {
        lastSeen.delete(token);
      }
    }

    if (lastSeen.size > maxEntries) {
      trimOldest(lastSeen.size - maxEntries);
    }

    lastCleanup = now;
  };

  const handler = (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    cleanup(now);

    const token = req.headers.authorization ?? req.ip;
    const last = token ? lastSeen.get(token) ?? now : now;
    if (token && now - last > ttlMs) {
      res.status(440).send('Session expired');
      return;
    }
    if (token) {
      lastSeen.set(token, now);
      if (lastSeen.size > maxEntries) {
        trimOldest(lastSeen.size - maxEntries);
      }
    }
    next();
  };

  // Expose minimal introspection for tests to assert eviction behavior.
  (handler as any).__getCacheSize = () => lastSeen.size;
  (handler as any).__hasToken = (token: string) => lastSeen.has(token);

  return handler;
}

