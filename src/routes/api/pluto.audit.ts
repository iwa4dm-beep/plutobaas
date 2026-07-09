// GET /api/pluto/audit
// Probes several critical upstream routes and returns a per-route health
// matrix (status, latency, last error). Powers the BackendAuditPanel so
// operators can see at a glance whether the proxy → API pipeline is
// reachable and, if not, exactly which route is failing.
import { createFileRoute } from "@tanstack/react-router";
import { getStatus, validateSecrets } from "@/lib/pluto/upstream-status";

type Probe = {
  path: string;
  label: string;
  method: "GET" | "OPTIONS";
  expectStatuses: number[]; // any of these counts as "reachable"
};

const PROBES: Probe[] = [
  { path: "/readyz",                       label: "Liveness (readyz)",       method: "GET",     expectStatuses: [200, 204] },
  { path: "/healthz",                      label: "Health (healthz)",        method: "GET",     expectStatuses: [200, 204, 404] },
  { path: "/admin/v1/workspaces",          label: "Admin · workspaces",      method: "OPTIONS", expectStatuses: [200, 204, 401, 403, 404] },
  { path: "/auth/v1/settings",             label: "Auth · settings",         method: "GET",     expectStatuses: [200, 401, 404] },
  { path: "/rest/v1/",                     label: "REST · root",             method: "GET",     expectStatuses: [200, 401, 404] },
  { path: "/storage/v1/bucket",            label: "Storage · buckets",       method: "GET",     expectStatuses: [200, 401, 403, 404] },
];

async function run(base: string, p: Probe): Promise<{
  path: string; label: string; ok: boolean; status: number | null;
  latencyMs: number; error: string | null;
}> {
  const url = base.replace(/\/$/, "") + p.path;
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3500);
  try {
    const res = await fetch(url, { method: p.method, signal: ctrl.signal });
    const ok = p.expectStatuses.includes(res.status);
    return {
      path: p.path, label: p.label, ok, status: res.status,
      latencyMs: Date.now() - started,
      error: ok ? null : `unexpected status ${res.status}`,
    };
  } catch (err) {
    return {
      path: p.path, label: p.label, ok: false, status: null,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(t);
  }
}

export const Route = createFileRoute("/api/pluto/audit")({
  server: {
    handlers: {
      GET: async () => {
        const issues = validateSecrets();
        const status = getStatus();
        const base = status.upstreamUrl;
        const results = base && issues.length === 0
          ? await Promise.all(PROBES.map((p) => run(base, p)))
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
