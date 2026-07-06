// Phase 15 · Dynamic CORS registry
// Loads admin.cors_origins from the database into an in-memory Set,
// refreshed every REFRESH_MS. The Fastify CORS `origin` callback consults
// this Set on every preflight/request. Mutations (POST/DELETE via the
// /admin/v1/cors/origins endpoints) call invalidate() so changes apply
// immediately without a server restart.
//
// Rules:
//   • Requests with no Origin header (curl, server-to-server) are allowed.
//   • Requests from localhost/127.0.0.1 are always allowed in NODE_ENV=development.
//   • CORS_ORIGINS env acts as a static fallback that is always merged in
//     (so the API's own domain / dashboard survive DB outages).
//   • Everything else must match a row in admin.cors_origins with enabled=true.

import type { Config } from '../config.js';
import { getSql } from '../db/pool.js';

const REFRESH_MS = 15_000;

type State = {
  origins: Set<string>;
  loadedAt: number;
  loading: Promise<void> | null;
};

const state: State = { origins: new Set(), loadedAt: 0, loading: null };

function normalize(o: string): string {
  return o.trim().toLowerCase().replace(/\/$/, '');
}

function staticOrigins(cfg: Config): string[] {
  if (!cfg.CORS_ORIGINS || cfg.CORS_ORIGINS === '*') return [];
  return cfg.CORS_ORIGINS.split(',').map((s) => normalize(s)).filter(Boolean);
}

async function loadFromDb(cfg: Config): Promise<void> {
  const sql = getSql(cfg);
  try {
    const rows = await sql<{ origin: string }[]>`
      select origin from admin.cors_origins where enabled = true
    `;
    const merged = new Set<string>(staticOrigins(cfg));
    for (const r of rows) merged.add(normalize(r.origin));
    state.origins = merged;
    state.loadedAt = Date.now();
  } catch {
    // Table may not exist yet (pre-migration) or DB may be unreachable.
    // Fall back to static env allow-list so the API's own domain still works.
    state.origins = new Set(staticOrigins(cfg));
    state.loadedAt = Date.now();
  }
}

async function ensureFresh(cfg: Config): Promise<void> {
  if (Date.now() - state.loadedAt < REFRESH_MS) return;
  if (state.loading) return state.loading;
  state.loading = loadFromDb(cfg).finally(() => { state.loading = null; });
  return state.loading;
}

export function invalidateCorsCache(): void {
  state.loadedAt = 0;
}

export async function primeCorsCache(cfg: Config): Promise<void> {
  await loadFromDb(cfg);
}

export function makeOriginCallback(cfg: Config) {
  const isDev = cfg.NODE_ENV !== 'production';
  const wildcard = cfg.CORS_ORIGINS === '*';
  return async function originCallback(
    origin: string | undefined,
    cb: (err: Error | null, allow?: boolean) => void,
  ): Promise<void> {
    // Same-origin / server-to-server / curl → no Origin header
    if (!origin) return cb(null, true);
    if (wildcard) return cb(null, true);
    const o = normalize(origin);
    if (isDev && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) {
      return cb(null, true);
    }
    try {
      await ensureFresh(cfg);
    } catch {
      // ignore — fall through with whatever we have
    }
    if (state.origins.has(o)) return cb(null, true);
    return cb(null, false);
  };
}

export function listCached(): string[] {
  return Array.from(state.origins).sort();
}
