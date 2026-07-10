// GET /api/pluto/audit
// Probes several critical upstream routes and returns a per-route health
// matrix with configurable timeout + exponential-backoff retry so transient
// failures don't flip the whole matrix red. On failure it also captures a
// short response body snippet so operators see the real upstream error.
//
// Query params (all optional):
//   ?timeoutMs=3500     – per-request timeout (200–15000)
//   ?maxRetries=1       – retries per probe on transient failure (0–4)
//   ?baseDelayMs=200    – initial backoff (50–2000, doubles each retry)
//   ?expect=<path>:<csv>  – override expected statuses per probe path, e.g.
//                           expect=/rest/v1/:200,400,401,404 (repeatable)
import { createFileRoute } from "@tanstack/react-router";
import { getStatus, validateSecrets } from "@/lib/pluto/upstream-status";

type Probe = {
  path: string;
  label: string;
  method: "GET" | "OPTIONS";
  expectStatuses: number[];
  // Optional fallback probes to try if the primary returns a nonstandard
  // status (e.g. some upstreams expose /health instead of /healthz). Each
  // fallback re-runs with a different method/path — the probe is considered
  // OK if any fallback succeeds.
  fallbacks?: Array<{ path?: string; method?: "GET" | "OPTIONS" | "HEAD"; expectStatuses?: number[] }>;
};

const DEFAULT_PROBES: Probe[] = [
  {
    path: "/readyz", label: "Liveness (readyz)", method: "GET",
    expectStatuses: [200, 204],
    fallbacks: [
      { method: "HEAD", expectStatuses: [200, 204, 405] },
      { path: "/ready", method: "GET", expectStatuses: [200, 204] },
      { path: "/", method: "GET", expectStatuses: [200, 204, 401, 404] },
    ],
  },
  {
    path: "/healthz", label: "Health (healthz)", method: "GET",
    expectStatuses: [200, 204],
    fallbacks: [
      { method: "HEAD", expectStatuses: [200, 204, 405] },
      { path: "/health", method: "GET", expectStatuses: [200, 204] },
      { path: "/livez", method: "GET", expectStatuses: [200, 204] },
    ],
  },
  // Preflight — sent with proper CORS headers below; backend also accepts a plain
  // 401/403/404 as "reachable" for unauthenticated callers.
  { path: "/admin/v1/workspaces", label: "Admin · workspaces", method: "OPTIONS", expectStatuses: [200, 204, 401, 403, 404] },
  { path: "/auth/v1/settings",    label: "Auth · settings",    method: "GET",     expectStatuses: [200, 401, 404] },
  // PostgREST-style root returns 400 "invalid_identifier" without a table segment
  // — that still proves the REST service is up and routing.
  { path: "/rest/v1/",            label: "REST · root",        method: "GET",     expectStatuses: [200, 400, 401, 404] },
  { path: "/storage/v1/bucket",   label: "Storage · buckets",  method: "GET",     expectStatuses: [200, 401, 403, 404] },
];

type Attempt = {
  attempt: number;      // 1-indexed
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
  waitedMs: number;     // backoff wait before this attempt
  variant?: string;     // "primary" | "fallback:METHOD path"
};

export type ProbeResult = {
  path: string;
  label: string;
  method: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
  bodySnippet: string | null;
  attempts: Attempt[];
  retriedCount: number;
  usedFallback?: string | null;
};

async function runOnce(
  base: string,
  method: string,
  path: string,
  expected: number[],
  timeoutMs: number,
  captureBody: boolean,
) {
  const url = base.replace(/\/$/, "") + path;
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (method === "OPTIONS") {
      // Send a valid CORS preflight so the upstream doesn't reject with 400
      // "Invalid Preflight Request".
      headers["Origin"] = new URL(base).origin;
      headers["Access-Control-Request-Method"] = "GET";
      headers["Access-Control-Request-Headers"] = "authorization,content-type";
    }
    const res = await fetch(url, { method, headers, signal: ctrl.signal });
    const ok = expected.includes(res.status);
    let snippet: string | null = null;
    // Always try to capture a body snippet on failure so operators can see the
    // real upstream error message without expanding retries.
    if (!ok && captureBody) {
      try {
        const txt = await res.text();
        snippet = txt.length > 500 ? `${txt.slice(0, 500)}…` : txt;
      } catch { /* ignore */ }
    }
    return {
      ok,
      status: res.status,
      latencyMs: Date.now() - started,
      error: ok ? null : `unexpected status ${res.status}`,
      bodySnippet: snippet,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: null as number | null,
      latencyMs: Date.now() - started,
      error: ctrl.signal.aborted ? `timeout after ${timeoutMs}ms` : msg,
      bodySnippet: null as string | null,
    };
  } finally {
    clearTimeout(t);
  }
}

async function probe(
  base: string,
  p: Probe,
  cfg: { timeoutMs: number; maxRetries: number; baseDelayMs: number },
): Promise<ProbeResult> {
  const attempts: Attempt[] = [];
  let last: Awaited<ReturnType<typeof runOnce>> = {
    ok: false, status: null, latencyMs: 0, error: "not run", bodySnippet: null,
  };
  let usedFallback: string | null = null;
  // Primary + retries.
  for (let i = 0; i <= cfg.maxRetries; i++) {
    const wait = i === 0 ? 0 : Math.min(4000, cfg.baseDelayMs * 2 ** (i - 1));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = await runOnce(base, p.method, p.path, p.expectStatuses, cfg.timeoutMs, /* captureBody */ true);
    attempts.push({
      attempt: attempts.length + 1, ok: last.ok, status: last.status,
      latencyMs: last.latencyMs, error: last.error, waitedMs: wait,
      variant: "primary",
    });
    if (last.ok) break;
  }
  // Fallback strategy — only run if primary failed with a nonstandard status
  // (i.e. we actually reached the upstream) or a network error. Skip if
  // primary already succeeded.
  if (!last.ok && p.fallbacks && p.fallbacks.length > 0) {
    for (const fb of p.fallbacks) {
      const method = fb.method ?? p.method;
      const path = fb.path ?? p.path;
      const expected = fb.expectStatuses ?? p.expectStatuses;
      const r = await runOnce(base, method, path, expected, cfg.timeoutMs, true);
      attempts.push({
        attempt: attempts.length + 1, ok: r.ok, status: r.status,
        latencyMs: r.latencyMs, error: r.error, waitedMs: 0,
        variant: `fallback:${method} ${path}`,
      });
      if (r.ok) {
        last = r;
        usedFallback = `${method} ${path}`;
        break;
      }
    }
  }
  return {
    path: p.path, label: p.label, method: p.method,
    ok: last.ok, status: last.status, latencyMs: last.latencyMs,
    error: last.error, bodySnippet: last.bodySnippet,
    attempts, retriedCount: Math.max(0, attempts.length - 1),
    usedFallback,
  };
}

function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw == null ? def : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function parseExpectOverrides(url: URL): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const raw of url.searchParams.getAll("expect")) {
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const path = raw.slice(0, idx);
    const list = raw.slice(idx + 1).split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 100 && n <= 599);
    if (list.length) m.set(path, list);
  }
  return m;
}

export const Route = createFileRoute("/api/pluto/audit")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const cfg = {
          timeoutMs:   clampInt(url.searchParams.get("timeoutMs"),   3500, 200, 15000),
          maxRetries:  clampInt(url.searchParams.get("maxRetries"),  1,    0,   4),
          baseDelayMs: clampInt(url.searchParams.get("baseDelayMs"), 200,  50,  2000),
        };
        const overrides = parseExpectOverrides(url);
        const probes: Probe[] = DEFAULT_PROBES.map((p) =>
          overrides.has(p.path) ? { ...p, expectStatuses: overrides.get(p.path)! } : p,
        );

        const issues = validateSecrets();
        const status = getStatus();
        const base = status.upstreamUrl;
        const results: ProbeResult[] = base && issues.length === 0
          ? await Promise.all(probes.map((p) => probe(base, p, cfg)))
          : [];
        const reachable = results.length > 0 && results.every((r) => r.ok);
        const failing = results.filter((r) => !r.ok);
        return new Response(
          JSON.stringify({
            ok: issues.length === 0 && reachable,
            configured: status.configured,
            upstreamUrl: base,
            issues,
            reachable,
            results,
            failingCount: failing.length,
            config: cfg,
            lastOkAt: status.lastOkAt,
            lastErrorAt: status.lastErrorAt,
            lastError: status.lastError,
            lastPath: status.lastPath,
            checkedAt: Date.now(),
          }, null, 2),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          },
        );
      },
    },
  },
});
