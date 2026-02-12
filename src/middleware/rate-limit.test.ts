import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createRateLimiter } from './rate-limit';
import type { AppEnv } from '../types';

function createApp(limit: number, windowMs: number) {
  const app = new Hono<AppEnv>();

  // Simulate accessUser being set (as CF Access middleware would do)
  app.use('*', async (c, next) => {
    const email = c.req.header('X-Test-Email');
    if (email) {
      c.set('accessUser', { email });
    }
    await next();
  });

  app.use('/limited/*', createRateLimiter({ limit, windowMs }));
  app.get('/limited/test', (c) => c.json({ ok: true }));

  return app;
}

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests within the limit', async () => {
    const app = createApp(3, 60_000);

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/limited/test', {
        headers: { 'X-Test-Email': 'user@example.com' },
      });
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 when limit is exceeded', async () => {
    const app = createApp(2, 60_000);

    // First 2 requests succeed
    for (let i = 0; i < 2; i++) {
      const res = await app.request('/limited/test', {
        headers: { 'X-Test-Email': 'user@example.com' },
      });
      expect(res.status).toBe(200);
    }

    // Third request is rate limited
    const res = await app.request('/limited/test', {
      headers: { 'X-Test-Email': 'user@example.com' },
    });
    expect(res.status).toBe(429);

    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe('Too many requests');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('resets after the window expires', async () => {
    const app = createApp(1, 60_000);

    // First request succeeds
    const res1 = await app.request('/limited/test', {
      headers: { 'X-Test-Email': 'user@example.com' },
    });
    expect(res1.status).toBe(200);

    // Second request is rate limited
    const res2 = await app.request('/limited/test', {
      headers: { 'X-Test-Email': 'user@example.com' },
    });
    expect(res2.status).toBe(429);

    // Advance time past the window
    vi.advanceTimersByTime(61_000);

    // Now it should work again
    const res3 = await app.request('/limited/test', {
      headers: { 'X-Test-Email': 'user@example.com' },
    });
    expect(res3.status).toBe(200);
  });

  it('tracks different users independently', async () => {
    const app = createApp(1, 60_000);

    const res1 = await app.request('/limited/test', {
      headers: { 'X-Test-Email': 'alice@example.com' },
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request('/limited/test', {
      headers: { 'X-Test-Email': 'bob@example.com' },
    });
    expect(res2.status).toBe(200);

    // Alice is now rate limited
    const res3 = await app.request('/limited/test', {
      headers: { 'X-Test-Email': 'alice@example.com' },
    });
    expect(res3.status).toBe(429);

    // Bob is also rate limited
    const res4 = await app.request('/limited/test', {
      headers: { 'X-Test-Email': 'bob@example.com' },
    });
    expect(res4.status).toBe(429);
  });

  it('falls back to CF-Connecting-IP when no accessUser', async () => {
    const app = createApp(1, 60_000);

    const res1 = await app.request('/limited/test', {
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    });
    expect(res1.status).toBe(200);

    const res2 = await app.request('/limited/test', {
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    });
    expect(res2.status).toBe(429);

    // Different IP is not limited
    const res3 = await app.request('/limited/test', {
      headers: { 'CF-Connecting-IP': '5.6.7.8' },
    });
    expect(res3.status).toBe(200);
  });

  it('cleans up stale entries when store exceeds MAX_ENTRIES', async () => {
    const app = createApp(1, 1_000);

    // Fill up with 101 unique users (exceeds MAX_ENTRIES of 100)
    for (let i = 0; i < 101; i++) {
      await app.request('/limited/test', {
        headers: { 'X-Test-Email': `user${i}@example.com` },
      });
    }

    // Advance time past the window so all entries are stale
    vi.advanceTimersByTime(2_000);

    // Next request should succeed (stale entries cleaned up)
    const res = await app.request('/limited/test', {
      headers: { 'X-Test-Email': 'new-user@example.com' },
    });
    expect(res.status).toBe(200);
  });
});
