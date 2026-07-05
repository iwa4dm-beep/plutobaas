import type { FastifyInstance } from 'fastify';
import { pingDb } from '../db/pool.js';
import type { Config } from '../config.js';

const startTime = Date.now();

export async function healthRoutes(app: FastifyInstance, cfg: Config) {
  // Liveness — process alive
  app.get('/livez', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    ts: new Date().toISOString(),
  }));

  // Readiness — dependencies reachable
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, any> = {};

    checks.db = await pingDb(cfg);

    // JWT sign+verify round-trip
    try {
      const token = await app.jwt.sign({ probe: true }, { expiresIn: '10s' });
      await app.jwt.verify(token);
      checks.jwt = { ok: true };
    } catch (e: any) {
      checks.jwt = { ok: false, error: e.message };
    }

    const healthy = Object.values(checks).every((c: any) => c.ok);
    reply.code(healthy ? 200 : 503);
    return { status: healthy ? 'ready' : 'degraded', checks, ts: new Date().toISOString() };
  });

  // Public health snapshot for /api/pluto/status probes
  app.get('/healthz', async () => ({ status: 'ok', service: 'pluto-api', ts: new Date().toISOString() }));

  // Auth v1 health (SDK / Lovable dashboard probe)
  app.get('/auth/v1/health', async () => ({ status: 'ok', service: 'pluto-auth', ts: new Date().toISOString() }));
}
