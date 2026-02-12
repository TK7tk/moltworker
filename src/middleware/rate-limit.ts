import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';

interface RateLimitOptions {
  /** Maximum requests allowed in the window */
  limit: number;
  /** Window size in milliseconds */
  windowMs: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const MAX_ENTRIES = 100;

/**
 * Create a sliding-window rate limiter middleware for Hono.
 *
 * Uses an in-memory Map keyed by the authenticated user's email
 * (from CF Access JWT) or the connecting IP address as fallback.
 * Workers isolates share memory within a single instance, providing
 * effective per-instance burst protection.
 *
 * When the Map grows beyond MAX_ENTRIES, stale (expired) entries
 * are purged to prevent unbounded memory growth.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const { limit, windowMs } = options;
  const store = new Map<string, RateLimitEntry>();

  function cleanup(now: number) {
    if (store.size <= MAX_ENTRIES) return;
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) {
        store.delete(key);
      }
    }
  }

  return async (c: Context<AppEnv>, next: Next) => {
    const now = Date.now();
    cleanup(now);

    const accessUser = c.get('accessUser');
    const key = accessUser?.email ?? c.req.header('CF-Connecting-IP') ?? 'unknown';

    const entry = store.get(key);

    if (!entry || entry.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }

    if (entry.count >= limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return c.json(
        { error: 'Too many requests', retryAfter },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } },
      );
    }

    store.set(key, { ...entry, count: entry.count + 1 });
    await next();
  };
}
