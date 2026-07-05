// GET /api/pluto/monitor
// Uptime probe that calls /api/pluto/status internally and — if a webhook is
// configured — POSTs an alert when upstream is unreachable or the last-error
// window is recent. Point an external uptime service (UptimeRobot, BetterStack,
// Cronitor, GitHub Actions cron) at this URL every 1–5 min.
import { createFileRoute } from "@tanstack/react-router";
import { getStatus, validateSecrets } from "@/lib/pluto/upstream-status";

const ALERT_WINDOW_MS = 5 * 60 * 1000; // treat errors in last 5 min as active

async function sendAlert(payload: unknown) {
  const url = process.env.MONITOR_WEBHOOK_URL;
  if (!url) return { sent: false, reason: "MONITOR_WEBHOOK_URL not set" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { sent: true, status: res.status };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export const Route = createFileRoute("/api/pluto/monitor")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const issues = validateSecrets();
        const status = getStatus();
        const now = Date.now();

        let reachable: { ok: boolean; status?: number; latencyMs: number; error?: string } | null = null;
        if (status.upstreamUrl && issues.length === 0) {
          const started = Date.now();
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 3000);
          try {
            const res = await fetch(status.upstreamUrl.replace(/\/$/, "") + "/readyz", { signal: ctrl.signal });
            reachable = { ok: res.ok, status: res.status, latencyMs: Date.now() - started };
          } catch (err) {
            reachable = { ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
          } finally {
            clearTimeout(timer);
          }
        }

        const recentError = status.lastErrorAt != null && now - status.lastErrorAt < ALERT_WINDOW_MS;
        const healthy = issues.length === 0 && reachable?.ok === true && !recentError;

        let alert: Awaited<ReturnType<typeof sendAlert>> | null = null;
        if (!healthy && new URL(request.url).searchParams.get("notify") !== "0") {
          alert = await sendAlert({
            source: "pluto-monitor",
            checkedAt: new Date(now).toISOString(),
            healthy,
            issues,
            reachable,
            lastError: status.lastError,
            lastErrorAt: status.lastErrorAt,
            lastPath: status.lastPath,
          });
        }

        return new Response(
          JSON.stringify({ healthy, issues, reachable, recentError, status, alert, checkedAt: now }, null, 2),
          {
            status: healthy ? 200 : 503,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          },
        );
      },
    },
  },
});
