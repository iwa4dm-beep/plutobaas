// TEMPORARY one-shot deployment route. Delete after use.
// Runs pushMigrations + uploadBundle + verifyDeploy against the upstream
// Pluto VPS using PLUTO_SERVICE_ROLE_KEY. Gated by X-Deploy-Token that must
// equal the service key itself (server-only value; only whoever already has
// the key can invoke).
import { createFileRoute } from "@tanstack/react-router";

type StepLog = { step: string; ok: boolean; status: number; latencyMs: number; url: string; body: string };

async function stepFetch(step: string, url: string, method: string, headers: Record<string, string>, body: BodyInit | null): Promise<StepLog> {
  const t = Date.now();
  try {
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    return { step, ok: res.ok, status: res.status, latencyMs: Date.now() - t, url, body: text.slice(0, 2000) };
  } catch (e) {
    return { step, ok: false, status: 0, latencyMs: Date.now() - t, url, body: (e as Error).message };
  }
}

export const Route = createFileRoute("/api/public/deploy-cello-once")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env.PLUTO_SERVICE_ROLE_KEY;
        if (!key) return Response.json({ ok: false, error: "PLUTO_SERVICE_ROLE_KEY not set" }, { status: 500 });
        const gate = request.headers.get("x-deploy-token");
        if (!gate || gate !== key) return new Response("Forbidden", { status: 403 });

        const base = (process.env.PLUTO_UPSTREAM_URL ?? "https://api.timescard.cloud").replace(/\/+$/, "");
        const payload = await request.json() as { workspaceId: string; sql: string; path: string; contentBase64: string };
        const h = { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" };
        const logs: StepLog[] = [];

        // Step 1: push migrations
        const mig = await stepFetch(
          "pushMigrations",
          `${base}/admin/v1/migrations`,
          "POST",
          { ...h, "content-type": "application/json" },
          JSON.stringify({ workspace_id: payload.workspaceId, sql: payload.sql, label: `cello-city-${new Date().toISOString()}` }),
        );
        logs.push(mig);

        // Step 2: upload bundle
        const bin = atob(payload.contentBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const clean = payload.path.replace(/^\/+/, "");
        const upl = await stepFetch(
          "uploadBundle",
          `${base}/storage/v1/object/deployments/${clean}`,
          "POST",
          { ...h, "content-type": "application/zip", "x-workspace-id": payload.workspaceId, "x-upsert": "true" },
          bytes,
        );
        logs.push({ ...upl, body: upl.body.slice(0, 500) });

        // Step 3: verify deploy
        const ver = await stepFetch(
          "verifyDeploy",
          `${base}/admin/v1/workspaces/${encodeURIComponent(payload.workspaceId)}/deployments?limit=1`,
          "GET",
          h,
          null,
        );
        logs.push(ver);

        return Response.json({ ok: logs.every(l => l.ok), bundleSize: bytes.length, logs });
      },
    },
  },
});
