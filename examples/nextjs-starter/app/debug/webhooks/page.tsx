"use client";

import { useCallback, useEffect, useState } from "react";

type RecentEvent = {
  at: number;
  outcome: "accepted" | "duplicate" | "rejected";
  eventId: string | null;
  eventType: string | null;
  reason?: string;
  backend?: "redis" | "file";
  expiresAt?: number | null;
  ttlRemaining?: number | null;
};

type Stats = {
  backend: "redis" | "file";
  durableSize: number;
  hotCacheSize: number;
  ttlMs: number;
};

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function badgeCls(o: RecentEvent["outcome"]): string {
  switch (o) {
    case "accepted":  return "bg-emerald-100 text-emerald-800";
    case "duplicate": return "bg-amber-100 text-amber-800";
    case "rejected":  return "bg-rose-100 text-rose-800";
  }
}

export default function WebhookDebugPage() {
  const [events, setEvents] = useState<RecentEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/webhooks/pluto/recent?limit=100", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setEvents(j.events ?? []);
      setStats(j.stats ?? null);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    if (!auto) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load, auto]);

  return (
    <main style={{ padding: "1.5rem", fontFamily: "system-ui, sans-serif", maxWidth: 960, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Webhook debug</h1>
      <p style={{ color: "#555", marginBottom: 16, fontSize: 13 }}>
        Recent <code>event.id</code> outcomes from <code>/api/webhooks/pluto</code> — accepted, duplicate, or rejected.
        TTL applies only to accepted/duplicate keys.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, fontSize: 13 }}>
        <button
          onClick={load}
          disabled={loading}
          style={{ padding: "4px 10px", border: "1px solid #ccc", borderRadius: 4, background: "#fff" }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
        <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto (3s)
        </label>
        {stats && (
          <span style={{ color: "#555" }}>
            backend=<code>{stats.backend}</code> · durable=<code>{stats.durableSize}</code> ·
            hot=<code>{stats.hotCacheSize}</code> · TTL=<code>{fmtMs(stats.ttlMs)}</code>
          </span>
        )}
      </div>

      {err && (
        <div style={{ padding: 8, background: "#fee", border: "1px solid #fbb", borderRadius: 4, marginBottom: 12 }}>
          {err}
        </div>
      )}

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: 6 }}>Time</th>
            <th style={{ padding: 6 }}>Outcome</th>
            <th style={{ padding: 6 }}>Type</th>
            <th style={{ padding: 6 }}>event.id</th>
            <th style={{ padding: 6 }}>TTL left</th>
            <th style={{ padding: 6 }}>Reason / backend</th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 && (
            <tr><td colSpan={6} style={{ padding: 12, color: "#888" }}>No events yet. Send a signed POST to /api/webhooks/pluto.</td></tr>
          )}
          {events.map((e, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={{ padding: 6, whiteSpace: "nowrap" }}>{new Date(e.at).toLocaleTimeString()}</td>
              <td style={{ padding: 6 }}>
                <span className={badgeCls(e.outcome)} style={{ padding: "2px 6px", borderRadius: 3, fontWeight: 500 }}>
                  {e.outcome}
                </span>
              </td>
              <td style={{ padding: 6 }}><code>{e.eventType ?? "—"}</code></td>
              <td style={{ padding: 6, fontFamily: "monospace", fontSize: 12 }}>{e.eventId ?? "—"}</td>
              <td style={{ padding: 6 }}>{fmtMs(e.ttlRemaining)}</td>
              <td style={{ padding: 6, color: "#666" }}>
                {e.reason ? <><code>{e.reason}</code></> : e.backend ? <>backend=<code>{e.backend}</code></> : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
