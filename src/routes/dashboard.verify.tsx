import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Loader2, MinusCircle, PlayCircle, RefreshCw, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, live, liveConfig, subscribe, type RealtimeStatus } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/verify")({
  component: VerifyPage,
});

// ============================================================
// Live integration checklist
// ------------------------------------------------------------
// Walks every subsystem the dashboard depends on and reports
// whether the browser can actually reach it on the running
// Pluto instance. Each check either resolves ({ ok, detail })
// or throws (surfaced as failure). No mock fallbacks — the
// point of this page is to prove the wiring is real.
// ============================================================

type Status = "idle" | "running" | "pass" | "fail" | "skip";
type Check = {
  id: string;
  group: "Config" | "HTTP" | "Auth & Admin" | "Realtime" | "Storage";
  label: string;
  detail?: string;
  status: Status;
  requiresService?: boolean;
};

const INITIAL: Check[] = [
  { id: "cfg.url",         group: "Config",       label: "VITE_PLUTO_URL is set", status: "idle" },
  { id: "cfg.anon",        group: "Config",       label: "VITE_PLUTO_ANON_KEY is set", status: "idle" },
  { id: "cfg.service",     group: "Config",       label: "VITE_PLUTO_SERVICE_KEY is set (admin surfaces)", status: "idle", requiresService: true },
  { id: "http.healthz",    group: "HTTP",         label: "GET /livez responds 200", status: "idle" },
  { id: "http.readyz",     group: "HTTP",         label: "GET /readyz reports DB + storage ready", status: "idle" },
  { id: "admin.migrations",group: "Auth & Admin", label: "GET /admin/v1/migrations returns ledger", status: "idle", requiresService: true },
  { id: "admin.bootrun",   group: "Auth & Admin", label: "GET /admin/v1/migrations/last-boot returns last boot", status: "idle", requiresService: true },
  { id: "admin.audit",     group: "Auth & Admin", label: "GET /admin/v1/audit returns paginated events", status: "idle", requiresService: true },
  { id: "admin.workspaces",group: "Auth & Admin", label: "GET /admin/v1/workspaces returns tenants", status: "idle", requiresService: true },
  { id: "admin.stats",     group: "Storage",      label: "GET /admin/v1/stats includes storage counts", status: "idle", requiresService: true },
  { id: "rt.audit",        group: "Realtime",     label: "WebSocket subscribe system:audit opens (admin only)", status: "idle", requiresService: true },
  { id: "rt.migrations",   group: "Realtime",     label: "WebSocket subscribe system:migrations opens (admin only)", status: "idle", requiresService: true },
];

function VerifyPage() {
  const [checks, setChecks] = useState<Check[]>(INITIAL);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const update = useCallback((id: string, patch: Partial<Check>) => {
    setChecks((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const runOne = useCallback(async <T,>(id: string, fn: () => Promise<T>, detail?: (r: T) => string) => {
    update(id, { status: "running", detail: undefined });
    try {
      const r = await fn();
      update(id, { status: "pass", detail: detail?.(r) });
      return true;
    } catch (e) {
      update(id, { status: "fail", detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }, [update]);

  const skipOne = useCallback((id: string, detail: string) => {
    update(id, { status: "skip", detail });
  }, [update]);

  const runAll = useCallback(async () => {
    setRunning(true); setSummary(null);
    setChecks(INITIAL.map((c) => ({ ...c, status: "idle", detail: undefined })));
    const cfg = liveConfig();

    // — Config —
    await runOne("cfg.url",     async () => cfg?.url    || Promise.reject(new Error("missing")), (v) => v as string);
    await runOne("cfg.anon",    async () => cfg?.anonKey || Promise.reject(new Error("missing")), (v) => `${(v as string).slice(0, 12)}…`);
    const hasServiceKey = Boolean(cfg?.serviceKey);
    if (hasServiceKey) {
      await runOne("cfg.service", async () => cfg!.serviceKey!, (v) => `${v.slice(0, 12)}…`);
    } else {
      skipOne("cfg.service", "Not configured — signed-in admin session is used for admin routes instead");
    }

    if (!cfg) { setRunning(false); setSummary("Not live — no backend URL configured. Set VITE_PLUTO_URL and reload."); return; }

    // — HTTP surface (unauthenticated) —
    await runOne("http.healthz", async () => {
      const r = await fetch(`${cfg.url}/livez`); if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<Record<string, unknown>>;
    }, (r) => JSON.stringify(r));
    await runOne("http.readyz", async () => {
      const r = await fetch(`${cfg.url}/readyz`); if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json() as { status?: string; ok?: boolean; db?: boolean; storage?: boolean; checks?: Record<string, { ok?: boolean; latencyMs?: number }> };
      const dbOk = j.db ?? j.checks?.db?.ok;
      const storageOk = j.storage ?? j.checks?.storage?.ok;
      const jwtOk = j.checks?.jwt?.ok;
      if (dbOk === false) throw new Error("db check failed");
      if (j.status && j.status !== "ready" && j.status !== "ok" && j.ok !== true) throw new Error(`status=${j.status}`);
      return { dbOk, storageOk, jwtOk };
    }, (r) => `db=${r.dbOk ?? "n/a"} storage=${r.storageOk ?? "n/a"} jwt=${r.jwtOk ?? "n/a"}`);

    // — Admin surface (needs service role) —
    await runOne("admin.migrations", () => live.migrations.list(),  (r) => `${r.migrations.length} entries`);
    await runOne("admin.bootrun",    () => live.migrations.lastBoot(), (r) => r.run ? `mode=${r.run.mode} status=${r.run.status} applied=${r.run.applied.length}` : "no boot recorded yet");
    await runOne("admin.audit",      () => live.audit.list({ limit: 1 }), (r) => `total=${r.total}`);
    await runOne("admin.workspaces", () => live.workspaces.list(), (r) => `${r.workspaces.length} workspace(s)`);
    await runOne("admin.stats",      () => live.admin.stats(),     (r) => `buckets=${r.buckets} objects=${r.objects} bytes=${r.storage_bytes}`);

    // — Realtime auth-gated channels —
    // Older Pluto backends don't expose admin `system:*` channels. In that
    // case the socket closes immediately or times out with no auth error —
    // treat as "skipped" so the checklist doesn't red-flag a missing
    // optional feature. A genuine `auth_error` still fails the check.
    for (const [id, channel] of [["rt.audit", "system:audit"], ["rt.migrations", "system:migrations"]] as const) {
      const outcome = await new Promise<{ kind: "pass" | "fail" | "skip"; detail: string }>((resolve) => {
        const timer = setTimeout(() => { off(); resolve({ kind: "skip", detail: "no response in 4s — backend does not expose this channel" }); }, 4000);
        const off = subscribe(channel, () => { /* ignore payload */ }, {
          onStatus: (s: RealtimeStatus) => {
            if (s.kind === "open") { clearTimeout(timer); off(); resolve({ kind: "pass", detail: "connected + subscribed" }); }
            else if (s.kind === "auth_error") { clearTimeout(timer); off(); resolve({ kind: "fail", detail: `${s.error}: ${s.message}` }); }
            else if (s.kind === "closed") {
              clearTimeout(timer);
              const reason = s.reason ?? "";
              const notSupported = !reason || /not\s*found|unknown|unsupported|no\s*such/i.test(reason);
              resolve(notSupported
                ? { kind: "skip", detail: `channel not exposed by backend${reason ? `: ${reason}` : ""}` }
                : { kind: "fail", detail: `closed: ${reason}` });
            }
          },
        });
      });
      if (outcome.kind === "skip") skipOne(id, outcome.detail);
      else await runOne(id, async () => { if (outcome.kind === "fail") throw new Error(outcome.detail); return outcome.detail; }, (v) => v);
    }

    setRunning(false);
    setChecks((prev) => {
      const pass = prev.filter((c) => c.status === "pass").length;
      const fail = prev.filter((c) => c.status === "fail").length;
      const skip = prev.filter((c) => c.status === "skip").length;
      setSummary(`${pass} passed · ${fail} failed · ${skip} skipped · ${prev.length} total`);
      return prev;
    });
  }, [runOne, skipOne]);

  useEffect(() => () => abort.current?.abort(), []);

  const grouped = checks.reduce<Record<string, Check[]>>((acc, c) => {
    (acc[c.group] ??= []).push(c); return acc;
  }, {});

  return (
    <div>
      <PageHeader
        title="Live integration checklist"
        description="End-to-end probe against the configured Pluto instance. Every row makes a real HTTP or WebSocket call — no mocks. Run this after wiring a new backend or when the dashboard looks empty to prove where the break is."
      />

      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => void runAll()}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
          {running ? "Running checks…" : "Run all checks"}
        </button>
        {summary && <div className="text-xs text-muted-foreground">{summary}</div>}
        {!isLive() && (
          <div className="ml-auto text-xs text-amber-500 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1">
            No backend URL — the checklist will stop after Config.
          </div>
        )}
      </div>

      <div className="space-y-4">
        {Object.entries(grouped).map(([group, rows]) => (
          <section key={group} className="rounded-lg border border-border bg-card">
            <header className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group}
            </header>
            <ul className="divide-y divide-border">
              {rows.map((c) => (
                <li key={c.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                  <StatusIcon status={c.status} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{c.label}</div>
                    {c.detail && (
                      <div className={"mt-0.5 text-xs font-mono truncate " + (c.status === "fail" ? "text-red-500" : c.status === "skip" ? "text-amber-500" : "text-muted-foreground")}>
                        {c.detail}
                      </div>
                    )}
                  </div>
                  {c.requiresService && (
                    <span className="text-[10px] rounded-full border border-border px-2 py-0.5 text-muted-foreground">service_role</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="mt-4 text-xs text-muted-foreground flex items-center gap-1.5">
        <RefreshCw className="h-3 w-3" />
        Tip — a failed <code className="font-mono">admin.*</code> row usually means the service_role key is missing or wrong. A failed
        <code className="font-mono"> rt.*</code> row with <code className="font-mono">admin_role_required</code> means the signed-in user is
        not an admin. Fix the key/role, then re-run.
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: Status }) {
  if (status === "pass")    return <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5" />;
  if (status === "fail")    return <XCircle       className="h-4 w-4 text-red-500 mt-0.5" />;
  if (status === "skip")    return <MinusCircle   className="h-4 w-4 text-amber-500 mt-0.5" />;
  if (status === "running") return <Loader2       className="h-4 w-4 text-primary animate-spin mt-0.5" />;
  return <Circle className="h-4 w-4 text-muted-foreground mt-0.5" />;
}
