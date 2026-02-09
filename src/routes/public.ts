import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Lightweight gateway readiness check (no auth required)
// IMPORTANT: This must NOT call sandbox.listProcesses() or any heavy DO
// operation. The loading page polls this every few seconds, and heavy DO
// calls here block the background ensureMoltbotGateway() from completing
// (DO serializes requests), creating a deadlock.
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Lightweight check: just try TCP connect to the gateway port.
    // Avoid listProcesses() which competes with background gateway startup.
    const probe = await sandbox.containerFetch(
      new Request('http://localhost/api/health'),
      MOLTBOT_PORT,
    );
    if (probe.ok) {
      return c.json({ ok: true, status: 'running' });
    }
    return c.json({ ok: false, status: 'not_responding' });
  } catch {
    return c.json({ ok: false, status: 'starting' });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

export { publicRoutes };
