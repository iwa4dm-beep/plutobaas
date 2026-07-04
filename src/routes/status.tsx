import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

type Check = { ok: boolean; error?: string; latency_ms?: number };
type Ready = { ok: boolean; uptime_s: number; checks: Record<string, Check> };

export const Route = createFileRoute("/status")({
  head: () => ({
    meta: [
      { title: "Pluto status" },
      { name: "description", content: "Live service status and regional health for the Pluto BaaS." },
      { property: "og:title", content: "Pluto status" },
      { property: "og:description", content: "Live service status and regional health for the Pluto BaaS." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: StatusPage,
});

const API = (import.meta.env.VITE_PLUTO_API_URL as string) || "http://localhost:8080";

function StatusPage() {
  const [ready, setReady] = useState<Ready | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    const tick = async () => {
      try {
        const r = await fetch(`${API}/readyz`);
        const j = (await r.json()) as Ready;
        if (!cancel) { setReady(j); setErr(null); }
      } catch (e) { if (!cancel) setErr((e as Error).message); }
    };
    tick(); const t = setInterval(tick, 15_000);
    return () => { cancel = true; clearInterval(t); };
  }, []);
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-3xl font-semibold mb-2">Service status</h1>
      <p className="text-muted-foreground mb-6">Live health of the Pluto API in this region.</p>
      {err && <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm">Health probe failed: {err}</div>}
      {ready && (
        <div className="space-y-3">
          <div className={`rounded p-4 ${ready.ok ? "bg-green-500/10 text-green-700" : "bg-destructive/10 text-destructive"}`}>
            {ready.ok ? "All systems operational" : "Degraded"}
            <span className="ml-3 text-xs opacity-70">uptime {Math.floor(ready.uptime_s / 60)} min</span>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {Object.entries(ready.checks).map(([k, v]) => (
                <tr key={k} className="border-t">
                  <td className="py-2 font-mono">{k}</td>
                  <td>{v.ok ? "OK" : (v.error ?? "fail")}</td>
                  <td className="text-right text-muted-foreground">{v.latency_ms ? `${v.latency_ms}ms` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
