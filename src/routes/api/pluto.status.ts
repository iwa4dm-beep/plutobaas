// GET /api/pluto/status
// Reports whether the Fastify upstream is configured, reachable, and the
// last error observed by the proxy. Used by TerminalCard + ops dashboards.
import { createFileRoute } from "@tanstack/react-router";
import { getStatus, validateSecrets } from "@/lib/pluto/upstream-status";

async function probe(url: string, signal: AbortSignal): Promise<{ ok: boolean; status?: number; error?: string; latencyMs: number }> {
  const started = Date.now();
  try {
    const res = await fetch(url.replace(/\/$/, "") + "/readyz", { signal });
    if (res.ok) return { ok: true, status: res.status, latencyMs: Date.now() - started };
    return { ok: false, status: res.status, error: `upstream returned ${res.status}`, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
  }
}

export const Route = createFileRoute("/api/pluto/status")({
  server: {
    handlers: {
      GET: async () => {
        const issues = validateSecrets();
        const status = getStatus();
        let reachable: Awaited<ReturnType<typeof probe>> | null = null;

        if (status.upstreamUrl && issues.length === 0) {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 3000);
          reachable = await probe(status.upstreamUrl, ctrl.signal);
          clearTimeout(t);
        }

        const ok = issues.length === 0 && (reachable?.ok ?? false);

        return new Response(
          JSON.stringify({
            ok,
            configured: status.configured,
            upstreamUrl: status.upstreamUrl,
            issues,
            reachable,
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
