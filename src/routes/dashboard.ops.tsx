import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle, CheckCircle2, Database, HardDriveDownload, HeartPulse,
  History, Play, RefreshCw, RotateCcw, ShieldAlert, Undo2,
} from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";
import {
  applyMigrations, applyRollbackMigrations, createBackup, dryRunMigrations,
  listBackups, listOpsEnvironments, planMigrations, planRollbackMigrations,
  restartService, restoreBackup, rolloutServices, serviceHealth,
  type OpsBackupEntry, type OpsEnv, type OpsResult, type OpsService, type RolloutPlan,
} from "@/lib/pluto/vps-ops.functions";

export const Route = createFileRoute("/dashboard/ops")({
  component: OpsPage,
  validateSearch: (s: Record<string, unknown>) => ({
    env: (s.env === "dev" || s.env === "staging" || s.env === "prod" ? s.env : "prod") as OpsEnv,
  }),
  head: () => ({
    meta: [
      { title: "Operations — Pluto BaaS" },
      { name: "description", content: "Multi-env migrations, staged rollouts, rollback, backups, and audit for the Pluto VPS backend." },
      { property: "og:title", content: "Operations — Pluto BaaS" },
      { property: "og:description", content: "Automate migrations, staged restarts, rollback, and backups from the dashboard." },
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

const ROLLOUT_PLANS: { key: RolloutPlan; label: string; hint: string }[] = [
  { key: "auto", label: "Auto (worker → realtime → api → nginx)", hint: "Recommended for most deployments" },
  { key: "workers-only", label: "Workers only", hint: "Restart sandbox worker in isolation" },
  { key: "canary-api", label: "Canary API", hint: "Health-gated API restart with soak" },
  { key: "full", label: "Full rollout", hint: "Same as auto but skip health gate" },
];

function OpsPageInner() {
  const { env } = Route.useSearch();
  const navigate = Route.useNavigate();
  const listEnvs = useServerFn(listOpsEnvironments);
  const [envs, setEnvs] = useState<{ env: OpsEnv; configured: boolean }[]>([
    { env: "dev", configured: false }, { env: "staging", configured: false }, { env: "prod", configured: true },
  ]);

  useEffect(() => {
    void listEnvs().then((r) => setEnvs(r as typeof envs)).catch(() => {});
  }, [listEnvs]);

  const isProd = env === "prod";

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Operations"
        description="Apply migrations, roll out services, roll back, and manage backups — no SSH required."
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground mr-1">Target environment:</span>
        {envs.map((e) => {
          const active = e.env === env;
          return (
            <button
              key={e.env}
              onClick={() => navigate({ search: { env: e.env } })}
              disabled={!e.configured}
              title={e.configured ? `Switch to ${e.env}` : `PLUTO_SANDBOX_SECRET_${e.env.toUpperCase()} not set`}
              className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wide transition ${
                active
                  ? e.env === "prod"
                    ? "border-red-500/60 bg-red-500/10 text-red-600 dark:text-red-300"
                    : "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent"
              } ${!e.configured ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              {e.env}
            </button>
          );
        })}
        <Link
          to="/dashboard/ops/executions"
          search={{ env, action: "", outcome: "" }}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          <History className="h-3.5 w-3.5" /> Executions
        </Link>
        <Link
          to="/dashboard/ops/audit"
          search={{ env }}
          className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          <History className="h-3.5 w-3.5" /> Audit log
        </Link>
      </div>

      {isProd && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4" /> You are targeting <b>PROD</b>. Destructive actions require typed <code>-PROD</code> confirmations.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <MigrationCard env={env} />
        <ServiceCard env={env} />
      </div>

      <BackupsCard env={env} />
    </div>
  );
}

/* -------------- Migration Card -------------- */

function MigrationCard({ env }: { env: OpsEnv }) {
  const plan = useServerFn(planMigrations);
  const dry = useServerFn(dryRunMigrations);
  const apply = useServerFn(applyMigrations);
  const planRollback = useServerFn(planRollbackMigrations);
  const applyRollback = useServerFn(applyRollbackMigrations);

  const [tab, setTab] = useState<"apply" | "rollback">("apply");
  const [busy, setBusy] = useState<null | string>(null);
  const [result, setResult] = useState<OpsResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState<null | "apply" | "rollback">(null);
  const [confirmText, setConfirmText] = useState("");
  const [skipBackup, setSkipBackup] = useState(false);
  const [target, setTarget] = useState("");
  const [allowMissingDown, setAllowMissingDown] = useState(false);

  const applyConfirmWord = env === "prod" ? "APPLY-PROD" : "APPLY";
  const rollbackConfirmWord = env === "prod" ? "ROLLBACK-PROD" : "ROLLBACK";

  const run = useCallback(async (kind: "plan" | "dry" | "apply" | "rollback-plan" | "rollback-apply") => {
    setBusy(kind);
    setResult(null);
    try {
      if (kind === "plan") setResult((await plan({ data: { env } })) as OpsResult);
      else if (kind === "dry") setResult((await dry({ data: { env } })) as OpsResult);
      else if (kind === "apply") {
        const r = (await apply({ data: { env, confirm: applyConfirmWord, skipBackup } })) as { backup: OpsResult | null; apply: OpsResult };
        setResult({ ...r.apply, tail: `${r.backup ? `[pre-apply backup] ${r.backup.tail}\n---\n` : ""}${r.apply.tail}` });
      } else if (kind === "rollback-plan") {
        setResult((await planRollback({ data: { env, target, allowMissingDown } })) as OpsResult);
      } else if (kind === "rollback-apply") {
        const r = (await applyRollback({ data: { env, target, allowMissingDown, confirm: rollbackConfirmWord } })) as { backup: OpsResult; rollback: OpsResult };
        setResult({ ...r.rollback, tail: `[pre-rollback backup] ${r.backup.tail}\n---\n${r.rollback.tail}` });
      }
    } catch (e) {
      setResult({
        ok: false, action: "migrations-plan", env, service: null, exitCode: -1, durationMs: 0,
        tail: e instanceof Error ? e.message : String(e), hint: null,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), backupId: null,
      });
    } finally {
      setBusy(null);
      setConfirmOpen(null);
      setConfirmText("");
    }
  }, [plan, dry, apply, planRollback, applyRollback, env, applyConfirmWord, rollbackConfirmWord, target, allowMissingDown, skipBackup]);

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <header className="flex items-center gap-2 mb-4">
        <Database className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">Migrations</h2>
        <div className="ml-auto inline-flex rounded-md border border-border p-0.5">
          <button onClick={() => setTab("apply")} className={`px-2 py-0.5 text-xs rounded ${tab === "apply" ? "bg-accent" : ""}`}>Apply</button>
          <button onClick={() => setTab("rollback")} className={`px-2 py-0.5 text-xs rounded ${tab === "rollback" ? "bg-accent" : ""}`}>Rollback</button>
        </div>
      </header>

      {tab === "apply" ? (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            Preview, dry-run, then apply. An automatic pre-apply backup runs first (toggle off to skip).
          </p>
          <div className="flex flex-wrap gap-2 mb-4">
            <ToolbarButton onClick={() => run("plan")} busy={busy === "plan"} disabled={!!busy}><RefreshCw className={`h-3.5 w-3.5 ${busy === "plan" ? "animate-spin" : ""}`} /> Plan</ToolbarButton>
            <ToolbarButton onClick={() => run("dry")} busy={busy === "dry"} disabled={!!busy}><ShieldAlert className={`h-3.5 w-3.5 ${busy === "dry" ? "animate-spin" : ""}`} /> Dry-run</ToolbarButton>
            <button
              onClick={() => setConfirmOpen("apply")}
              disabled={!!busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" /> Apply
            </button>
            <label className="ml-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={skipBackup} onChange={(e) => setSkipBackup(e.target.checked)} /> Skip backup
            </label>
          </div>
          {confirmOpen === "apply" && (
            <ConfirmBox
              word={applyConfirmWord}
              tone={env === "prod" ? "danger" : "warn"}
              message={<>Type <code className="rounded bg-muted px-1">{applyConfirmWord}</code> to apply on <b>{env}</b>{skipBackup ? " (backup SKIPPED)" : ""}.</>}
              value={confirmText}
              onChange={setConfirmText}
              onCancel={() => { setConfirmOpen(null); setConfirmText(""); }}
              onConfirm={() => run("apply")}
              disabled={confirmText !== applyConfirmWord || !!busy}
            />
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            Roll back to a target migration version. Down-migration files (<code>NNNN_*.down.sql</code>) are collected in reverse order and applied in a single transaction. A backup always runs first.
          </p>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input
              value={target} onChange={(e) => setTarget(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="target version e.g. 0038"
              className="w-56 rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
            <ToolbarButton onClick={() => run("rollback-plan")} busy={busy === "rollback-plan"} disabled={!target || !!busy}>
              <RefreshCw className={`h-3.5 w-3.5 ${busy === "rollback-plan" ? "animate-spin" : ""}`} /> Plan rollback
            </ToolbarButton>
            <button
              onClick={() => setConfirmOpen("rollback")}
              disabled={!target || !!busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              <Undo2 className="h-3.5 w-3.5" /> Apply rollback
            </button>
            <label className="ml-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={allowMissingDown} onChange={(e) => setAllowMissingDown(e.target.checked)} /> Allow missing down
            </label>
          </div>
          {confirmOpen === "rollback" && (
            <ConfirmBox
              word={rollbackConfirmWord}
              tone="danger"
              message={<>Rollback to <b>{target}</b> on <b>{env}</b>. Type <code className="rounded bg-muted px-1">{rollbackConfirmWord}</code> to proceed.</>}
              value={confirmText}
              onChange={setConfirmText}
              onCancel={() => { setConfirmOpen(null); setConfirmText(""); }}
              onConfirm={() => run("rollback-apply")}
              disabled={confirmText !== rollbackConfirmWord || !!busy}
            />
          )}
        </>
      )}

      <OpsResultView result={result} />
    </section>
  );
}

/* -------------- Service Card -------------- */

function ServiceCard({ env }: { env: OpsEnv }) {
  const health = useServerFn(serviceHealth);
  const restart = useServerFn(restartService);
  const rollout = useServerFn(rolloutServices);

  const [healthResult, setHealthResult] = useState<OpsResult | null>(null);
  const [actionResult, setActionResult] = useState<OpsResult | null>(null);
  const [pending, setPending] = useState<OpsService | "rollout" | null>(null);
  const [confirm, setConfirm] = useState<{ service: OpsService; text: string } | null>(null);
  const [rolloutOpen, setRolloutOpen] = useState(false);
  const [rolloutPlan, setRolloutPlan] = useState<RolloutPlan>("auto");
  const [rolloutSoak, setRolloutSoak] = useState(30);
  const [rolloutConfirm, setRolloutConfirm] = useState("");

  const rolloutWord = env === "prod" ? "ROLLOUT-PROD" : "ROLLOUT";

  const loadHealth = useCallback(async () => {
    try { setHealthResult((await health({ data: { env } })) as OpsResult); } catch { /* ignore */ }
  }, [health, env]);

  useEffect(() => {
    void loadHealth();
    const id = setInterval(() => { void loadHealth(); }, 15_000);
    return () => clearInterval(id);
  }, [loadHealth]);

  const doRestart = async (service: OpsService) => {
    setPending(service);
    setActionResult(null);
    try {
      const r = (await restart({ data: { env, service, confirm: service } })) as OpsResult;
      setActionResult(r);
      await loadHealth();
    } catch (e) {
      setActionResult({
        ok: false, action: "service-restart", env, service, exitCode: -1, durationMs: 0,
        tail: e instanceof Error ? e.message : String(e), hint: null,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), backupId: null,
      });
    } finally { setPending(null); setConfirm(null); }
  };

  const doRollout = async () => {
    setPending("rollout"); setActionResult(null);
    try {
      const r = (await rollout({ data: { env, plan: rolloutPlan, soakSeconds: rolloutSoak, confirm: rolloutWord } })) as OpsResult;
      setActionResult(r);
      await loadHealth();
    } catch (e) {
      setActionResult({
        ok: false, action: "service-rollout", env, service: null, exitCode: -1, durationMs: 0,
        tail: e instanceof Error ? e.message : String(e), hint: null,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), backupId: null,
      });
    } finally { setPending(null); setRolloutOpen(false); setRolloutConfirm(""); }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <header className="flex items-center gap-2 mb-4">
        <HeartPulse className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">Services</h2>
        <button onClick={() => void loadHealth()} className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </header>

      <ul className="divide-y divide-border border border-border rounded-md mb-3">
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
                    autoFocus value={confirm.text}
                    onChange={(e) => setConfirm({ service: s.key, text: e.target.value })}
                    placeholder={s.key}
                    className="w-32 rounded-md border border-border bg-background px-2 py-1 text-xs"
                  />
                  <button onClick={() => doRestart(s.key)} disabled={confirm.text !== s.key || isPending}
                    className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">Restart</button>
                  <button onClick={() => setConfirm(null)} className="rounded-md border border-border px-2 py-1 text-xs">Cancel</button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirm({ service: s.key, text: "" })}
                  disabled={pending !== null}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                >
                  <RotateCcw className={`h-3 w-3 ${isPending ? "animate-spin" : ""}`} />
                  {s.key === "nginx-reload" ? "Reload" : "Restart"}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="rounded-md border border-border p-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="text-sm font-medium">Staged rollout</div>
          <span className="text-[11px] text-muted-foreground">restart all services in a health-gated sequence</span>
          <button
            onClick={() => setRolloutOpen((v) => !v)}
            className="ml-auto rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
          >{rolloutOpen ? "Cancel" : "Configure…"}</button>
        </div>
        {rolloutOpen && (
          <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="text-xs text-muted-foreground">Plan
                <select value={rolloutPlan} onChange={(e) => setRolloutPlan(e.target.value as RolloutPlan)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm">
                  {ROLLOUT_PLANS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">Soak (seconds, after API)
                <input type="number" min={0} max={300} value={rolloutSoak} onChange={(e) => setRolloutSoak(Number(e.target.value) || 0)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm" />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input placeholder={rolloutWord} value={rolloutConfirm} onChange={(e) => setRolloutConfirm(e.target.value)}
                className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" />
              <button
                onClick={doRollout}
                disabled={rolloutConfirm !== rolloutWord || pending === "rollout"}
                className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
              >Start rollout</button>
            </div>
          </div>
        )}
      </div>

      {healthResult && (
        <div className="mt-4">
          <div className="text-xs text-muted-foreground mb-1">Last health check · {new Date(healthResult.finishedAt).toLocaleTimeString()}</div>
          <pre className="max-h-40 overflow-auto rounded-md bg-muted/30 p-2 text-[11px] leading-relaxed">
            {healthResult.tail || "(no output)"}
          </pre>
        </div>
      )}
      <OpsResultView result={actionResult} />
    </section>
  );
}

/* -------------- Backups Card -------------- */

function BackupsCard({ env }: { env: OpsEnv }) {
  const list = useServerFn(listBackups);
  const create = useServerFn(createBackup);
  const restore = useServerFn(restoreBackup);

  const [entries, setEntries] = useState<OpsBackupEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "create" | string>(null);
  const [restoreOpen, setRestoreOpen] = useState<null | OpsBackupEntry>(null);
  const [confirmText, setConfirmText] = useState("");
  const [result, setResult] = useState<OpsResult | null>(null);

  const restoreWord = env === "prod" ? "RESTORE-PROD" : "RESTORE";

  const load = useCallback(async () => {
    const r = (await list({ data: { env, limit: 20 } })) as { ok: boolean; entries: OpsBackupEntry[]; error?: string };
    setEntries(r.entries || []); setError(r.error || null);
  }, [list, env]);

  useEffect(() => { void load(); }, [load]);

  const latest = entries[0];
  const latestAge = useMemo(() => {
    if (!latest) return null;
    const ms = Date.now() - new Date(latest.createdAt).getTime();
    return ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m ago` : `${Math.round(ms / 3_600_000)}h ago`;
  }, [latest]);

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <header className="flex items-center gap-2 mb-4">
        <HardDriveDownload className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">Backups</h2>
        <span className="text-xs text-muted-foreground">env = {env}</span>
        <button
          onClick={async () => { setBusy("create"); setResult(null); try { setResult((await create({ data: { env } })) as OpsResult); await load(); } finally { setBusy(null); } }}
          disabled={busy !== null}
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${busy === "create" ? "animate-spin" : ""}`} /> New backup
        </button>
      </header>

      {latest ? (
        <div className="mb-3 text-xs text-muted-foreground">
          Latest: <span className="font-mono">{latest.id.slice(0, 12)}</span> · {formatSize(latest.size)} · {latestAge}
        </div>
      ) : <div className="mb-3 text-xs text-muted-foreground">No backups yet on this environment.</div>}
      {error && <div className="mb-2 text-xs text-red-600">{error}</div>}

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-left">
            <tr><th className="p-2">Created</th><th className="p-2">ID</th><th className="p-2">Size</th><th className="p-2">SHA-256</th><th className="p-2 text-right">Actions</th></tr>
          </thead>
          <tbody>
            {entries.map((b) => (
              <tr key={b.id} className="border-t border-border">
                <td className="p-2 whitespace-nowrap">{new Date(b.createdAt).toLocaleString()}</td>
                <td className="p-2 font-mono truncate max-w-[160px]" title={b.id}>{b.id}</td>
                <td className="p-2 whitespace-nowrap">{formatSize(b.size)}</td>
                <td className="p-2 font-mono truncate max-w-[160px]" title={b.sha256}>{b.sha256?.slice(0, 12)}…</td>
                <td className="p-2 text-right">
                  <button onClick={() => { setRestoreOpen(b); setConfirmText(""); }}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">Restore</button>
                </td>
              </tr>
            ))}
            {entries.length === 0 && <tr><td colSpan={5} className="p-3 text-center text-muted-foreground">No backups.</td></tr>}
          </tbody>
        </table>
      </div>

      {restoreOpen && (
        <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm space-y-2">
          <div className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4 text-red-500" />
            Restore backup <span className="font-mono text-xs">{restoreOpen.id}</span> on <b>{env}</b>
          </div>
          <p className="text-xs text-muted-foreground">This will run <code>pg_restore --clean --if-exists</code> and overwrite current data. Type <code className="rounded bg-muted px-1">{restoreWord}</code>.</p>
          <div className="flex gap-2">
            <input autoFocus value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={restoreWord}
              className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" />
            <button
              onClick={async () => {
                setBusy(restoreOpen.id); setResult(null);
                try {
                  setResult((await restore({ data: { env, id: restoreOpen.id, confirm: restoreWord } })) as OpsResult);
                } finally { setBusy(null); setRestoreOpen(null); setConfirmText(""); }
              }}
              disabled={confirmText !== restoreWord || busy !== null}
              className="rounded-md bg-destructive px-3 py-1 text-sm text-destructive-foreground disabled:opacity-50"
            >Restore</button>
            <button onClick={() => { setRestoreOpen(null); setConfirmText(""); }} className="rounded-md border border-border px-3 py-1 text-sm">Cancel</button>
          </div>
        </div>
      )}

      <OpsResultView result={result} />
    </section>
  );
}

/* -------------- Shared components -------------- */

function ToolbarButton({ children, onClick, disabled, busy }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50">
      {children}
    </button>
  );
}

function ConfirmBox({ word, tone, message, value, onChange, onCancel, onConfirm, disabled }: {
  word: string; tone: "warn" | "danger"; message: React.ReactNode;
  value: string; onChange: (v: string) => void; onCancel: () => void; onConfirm: () => void; disabled: boolean;
}) {
  const border = tone === "danger" ? "border-red-500/40 bg-red-500/5" : "border-amber-500/40 bg-amber-500/5";
  const icon = tone === "danger" ? "text-red-500" : "text-amber-500";
  return (
    <div className={`rounded-md border ${border} p-3 mb-4 text-sm space-y-2`}>
      <div className="flex items-center gap-2 font-medium"><AlertTriangle className={`h-4 w-4 ${icon}`} />{message}</div>
      <div className="flex gap-2">
        <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={word}
          className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" />
        <button onClick={onConfirm} disabled={disabled}
          className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50">Confirm</button>
        <button onClick={onCancel} className="rounded-md border border-border px-3 py-1 text-sm">Cancel</button>
      </div>
    </div>
  );
}

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
        {result.ok ? "Success" : "Failed"} · {result.action} · <span className="uppercase text-[10px] tracking-wide">{result.env}</span>
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

function formatSize(n: number): string {
  if (!n || n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
