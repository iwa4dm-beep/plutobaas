import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, HeartPulse, Play, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";
import {
  applyMigrations,
  dryRunMigrations,
  planMigrations,
  restartService,
  serviceHealth,
  type OpsResult,
  type OpsService,
} from "@/lib/pluto/vps-ops.functions";

export const Route = createFileRoute("/dashboard/ops")({
  component: OpsPage,
  head: () => ({
    meta: [
      { title: "Operations — Pluto BaaS" },
      { name: "description", content: "One-click migration apply and service restart for the Pluto VPS backend." },
      { property: "og:title", content: "Operations — Pluto BaaS" },
      { property: "og:description", content: "Automate migrations and service restarts from the dashboard." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function OpsPage() {
  return (
    <TraceAccessGate permission="manage">
      <OpsPageInner />
    </TraceAccessGate>
  );
}

const SERVICES: { key: OpsService; label: string; description: string }[] = [
  { key: "api", label: "API server", description: "pluto-api container / systemd unit" },
  { key: "realtime", label: "Realtime", description: "WebSocket & CDC worker" },
  { key: "worker", label: "Sandbox worker", description: "pluto-sandbox-worker systemd" },
  { key: "nginx-reload", label: "Nginx (reload)", description: "graceful reload, no downtime" },
];

function OpsPageInner() {
  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Operations"
        description="Apply migrations and restart services on the VPS backend — no SSH required."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <MigrationCard />
        <ServiceCard />
      </div>
    </div>
  );
}

/* -------------- Migration Card -------------- */

function MigrationCard() {
  const plan = useServerFn(planMigrations);
  const dry = useServerFn(dryRunMigrations);
  const apply = useServerFn(applyMigrations);

  const [busy, setBusy] = useState<null | "plan" | "dry" | "apply">(null);
  const [result, setResult] = useState<OpsResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const run = useCallback(async (kind: "plan" | "dry" | "apply") => {
    setBusy(kind);
    setResult(null);
    try {
      const r = (
        kind === "plan" ? await plan()
        : kind === "dry" ? await dry()
        : await apply({ data: { confirm: "APPLY" } })
      ) as OpsResult;
      setResult(r);
    } catch (e) {
      setResult({
        ok: false, action: kind === "apply" ? "migrations-apply" : kind === "dry" ? "migrations-dry-run" : "migrations-plan",
        exitCode: -1, durationMs: 0, tail: e instanceof Error ? e.message : String(e),
        hint: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
    } finally {
      setBusy(null);
      setConfirmOpen(false);
      setConfirmText("");
    }
  }, [plan, dry, apply]);

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <header className="flex items-center gap-2 mb-4">
        <Play className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">Migration Control</h2>
      </header>

      <p className="text-sm text-muted-foreground mb-4">
        Preview pending SQL migrations, dry-run them inside a rolled-back transaction, and apply on success.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        <button
          onClick={() => run("plan")}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy === "plan" ? "animate-spin" : ""}`} /> Plan
        </button>
        <button
          onClick={() => run("dry")}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          <ShieldAlert className={`h-3.5 w-3.5 ${busy === "dry" ? "animate-spin" : ""}`} /> Dry-run
        </button>
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5" /> Apply
        </button>
      </div>

      {confirmOpen && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 mb-4 text-sm space-y-2">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Confirm apply — this modifies production data.
          </div>
          <p className="text-muted-foreground text-xs">
            Type <code className="rounded bg-muted px-1">APPLY</code> to proceed.
          </p>
          <div className="flex gap-2">
            <input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="APPLY"
              className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
            <button
              onClick={() => run("apply")}
              disabled={confirmText !== "APPLY" || busy !== null}
              className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
            >Apply</button>
            <button
              onClick={() => { setConfirmOpen(false); setConfirmText(""); }}
              className="rounded-md border border-border px-3 py-1 text-sm"
            >Cancel</button>
          </div>
        </div>
      )}

      <OpsResultView result={result} />
    </section>
  );
}

/* -------------- Service Card -------------- */

function ServiceCard() {
  const health = useServerFn(serviceHealth);
  const restart = useServerFn(restartService);

  const [healthResult, setHealthResult] = useState<OpsResult | null>(null);
  const [restartResult, setRestartResult] = useState<OpsResult | null>(null);
  const [pending, setPending] = useState<OpsService | null>(null);
  const [confirm, setConfirm] = useState<{ service: OpsService; text: string } | null>(null);

  const loadHealth = useCallback(async () => {
    try { setHealthResult((await health()) as OpsResult); } catch { /* ignore */ }
  }, [health]);

  useEffect(() => {
    void loadHealth();
    const id = setInterval(() => { void loadHealth(); }, 15_000);
    return () => clearInterval(id);
  }, [loadHealth]);

  const doRestart = async (service: OpsService) => {
    setPending(service);
    setRestartResult(null);
    try {
      const r = (await restart({ data: { service, confirm: service } })) as OpsResult;
      setRestartResult(r);
      await loadHealth();
    } catch (e) {
      setRestartResult({
        ok: false, action: "service-restart", service, exitCode: -1, durationMs: 0,
        tail: e instanceof Error ? e.message : String(e), hint: null,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
    } finally {
      setPending(null);
      setConfirm(null);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <header className="flex items-center gap-2 mb-4">
        <HeartPulse className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">Service Control</h2>
        <button
          onClick={() => void loadHealth()}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          title="Refresh health"
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </header>

      <ul className="divide-y divide-border border border-border rounded-md">
        {SERVICES.map((s) => {
          const isPending = pending === s.key;
          const confirmActive = confirm?.service === s.key;
          return (
            <li key={s.key} className="p-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{s.label}</div>
                <div className="text-xs text-muted-foreground truncate">{s.description}</div>
              </div>
              {confirmActive ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={confirm.text}
                    onChange={(e) => setConfirm({ service: s.key, text: e.target.value })}
                    placeholder={s.key}
                    className="w-32 rounded-md border border-border bg-background px-2 py-1 text-xs"
                  />
                  <button
                    onClick={() => doRestart(s.key)}
                    disabled={confirm.text !== s.key || isPending}
                    className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                  >Restart</button>
                  <button
                    onClick={() => setConfirm(null)}
                    className="rounded-md border border-border px-2 py-1 text-xs"
                  >Cancel</button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirm({ service: s.key, text: "" })}
                  disabled={pending !== null}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                  title={`Restart ${s.label}`}
                >
                  <RotateCcw className={`h-3 w-3 ${isPending ? "animate-spin" : ""}`} />
                  {s.key === "nginx-reload" ? "Reload" : "Restart"}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {healthResult && (
        <div className="mt-4">
          <div className="text-xs text-muted-foreground mb-1">Last health check · {new Date(healthResult.finishedAt).toLocaleTimeString()}</div>
          <pre className="max-h-40 overflow-auto rounded-md bg-muted/30 p-2 text-[11px] leading-relaxed">
            {healthResult.tail || "(no output)"}
          </pre>
        </div>
      )}

      <OpsResultView result={restartResult} />
    </section>
  );
}

/* -------------- Shared result view -------------- */

function OpsResultView({ result }: { result: OpsResult | null }) {
  if (!result) return null;
  const Icon = result.ok ? CheckCircle2 : AlertTriangle;
  const tone = result.ok
    ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
    : "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300";
  return (
    <div className={`mt-4 rounded-md border p-3 text-sm ${tone}`}>
      <div className="flex items-center gap-2 font-medium">
        <Icon className="h-4 w-4" />
        {result.ok ? "Success" : "Failed"} · {result.action}
        {result.service ? ` · ${result.service}` : ""}
        <span className="ml-auto text-xs opacity-70">{result.durationMs}ms · exit {result.exitCode}</span>
      </div>
      {result.hint && <p className="mt-1 text-xs opacity-90">{result.hint}</p>}
      {result.tail && (
        <pre className="mt-2 max-h-56 overflow-auto rounded bg-background/70 p-2 text-[11px] leading-relaxed text-foreground">
          {result.tail}
        </pre>
      )}
    </div>
  );
}
