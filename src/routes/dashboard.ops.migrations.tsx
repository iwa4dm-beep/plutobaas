import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ArrowLeft, CheckCircle2, ListChecks, Loader2, PlayCircle, Undo2, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";
import {
  applyMigrations, applyRollbackMigrations, dryRunMigrations, planMigrations,
  planRollbackMigrations, type OpsEnv, type OpsResult,
} from "@/lib/pluto/vps-ops.functions";

export const Route = createFileRoute("/dashboard/ops/migrations")({
  component: MigrationsPage,
  validateSearch: (s: Record<string, unknown>) => ({
    env: (s.env === "dev" || s.env === "staging" || s.env === "prod" ? s.env : "prod") as OpsEnv,
  }),
  head: () => ({
    meta: [
      { title: "Migration dry-run & rollback — Pluto Ops" },
      { name: "description", content: "Preview pending SQL migrations, safely dry-run them in a rolled-back transaction, and revert a specific version when a down-migration exists." },
      { property: "og:title", content: "Migration dry-run & rollback — Pluto Ops" },
      { property: "og:description", content: "Plan, dry-run, apply, and roll back Pluto BaaS migrations from the dashboard." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function MigrationsPage() {
  return (
    <TraceAccessGate permission="manage">
      <MigrationsInner />
    </TraceAccessGate>
  );
}

function extractPendingList(tail: string): string[] {
  // pluto-ops emits lines like "  • 0041_pii_alerts.sql" during plan/dry-run.
  return tail.split("\n")
    .map((l) => l.trim().replace(/^[•*-]\s+/, ""))
    .filter((l) => /^[0-9]{4}[A-Za-z0-9_.-]+\.sql\b/.test(l));
}

function StatusBadge({ result }: { result: OpsResult | null }) {
  if (!result) return null;
  if (result.ok) return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500"><CheckCircle2 className="h-3 w-3" /> ok · {result.durationMs}ms</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive"><XCircle className="h-3 w-3" /> exit {result.exitCode}</span>;
}

function ResultCard({ title, result, tone }: { title: string; result: OpsResult | null; tone: "plan" | "dry" | "apply" | "roll" }) {
  if (!result) return null;
  const pending = tone === "plan" || tone === "dry" ? extractPendingList(result.tail) : [];
  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-2">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <StatusBadge result={result} />
      </header>
      {pending.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">Pending migrations detected ({pending.length}):</p>
          <ul className="text-xs font-mono space-y-0.5">
            {pending.map((p) => <li key={p} className="rounded bg-muted px-2 py-1">{p}</li>)}
          </ul>
        </div>
      )}
      {result.hint && (
        <p className="text-xs rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="inline h-3 w-3 mr-1" />{result.hint}
        </p>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Show raw output ({result.tail.length} bytes)</summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap font-mono">{result.tail || "(empty)"}</pre>
      </details>
    </section>
  );
}

function MigrationsInner() {
  const { env } = Route.useSearch();
  const navigate = Route.useNavigate();
  const plan = useServerFn(planMigrations);
  const dry = useServerFn(dryRunMigrations);
  const apply = useServerFn(applyMigrations);
  const rbPlan = useServerFn(planRollbackMigrations);
  const rbApply = useServerFn(applyRollbackMigrations);

  const [busy, setBusy] = useState<null | "plan" | "dry" | "apply" | "rb-plan" | "rb-apply">(null);
  const [planRes, setPlanRes] = useState<OpsResult | null>(null);
  const [dryRes, setDryRes] = useState<OpsResult | null>(null);
  const [applyRes, setApplyRes] = useState<{ backup: OpsResult | null; apply: OpsResult } | null>(null);
  const [rbPlanRes, setRbPlanRes] = useState<OpsResult | null>(null);
  const [rbApplyRes, setRbApplyRes] = useState<{ backup: OpsResult; rollback: OpsResult } | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState("");
  const [allowMissingDown, setAllowMissingDown] = useState(false);

  const run = useCallback(async <T,>(kind: typeof busy, fn: () => Promise<T>, set: (v: T) => void) => {
    setBusy(kind); try { set(await fn()); } finally { setBusy(null); }
  }, []);

  const confirmApply = env === "prod" ? "APPLY-PROD" : "APPLY";
  const confirmRb = env === "prod" ? "ROLLBACK-PROD" : "ROLLBACK";

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/dashboard/ops" search={{ env }} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Operations
        </Link>
      </div>

      <PageHeader
        title="Migration dry-run & rollback"
        description={`Environment: ${env} — safely preview pending SQL, apply with automatic pre-backup, and revert a specific version when a down-migration is available.`}
      />

      <div className="flex flex-wrap items-center gap-2">
        {(["dev", "staging", "prod"] as OpsEnv[]).map((e) => (
          <button key={e} onClick={() => navigate({ search: { env: e } })}
            className={`rounded-md px-3 py-1.5 text-xs font-medium border ${e === env ? "bg-primary text-primary-foreground border-primary" : "bg-card hover:bg-accent border-border"}`}>
            {e}
          </button>
        ))}
      </div>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={busy !== null}
            onClick={() => run("plan", () => plan({ data: { env } }), setPlanRes)}
            className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm font-medium hover:bg-secondary/80 disabled:opacity-50">
            {busy === "plan" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
            List pending
          </button>
          <button disabled={busy !== null}
            onClick={() => run("dry", () => dry({ data: { env } }), setDryRes)}
            className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm font-medium hover:bg-secondary/80 disabled:opacity-50">
            {busy === "dry" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            Dry-run (staging tx, rolled back)
          </button>
          <button disabled={busy !== null}
            onClick={async () => {
              const c = window.prompt(`Type ${confirmApply} to apply pending migrations to ${env}. A backup will run first.`);
              if (c !== confirmApply) return;
              await run("apply", () => apply({ data: { env, confirm: confirmApply, skipBackup: false } }), setApplyRes);
            }}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {busy === "apply" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Apply pending
          </button>
        </div>
        <ResultCard title="Plan" result={planRes} tone="plan" />
        <ResultCard title="Dry-run" result={dryRes} tone="dry" />
        {applyRes && (
          <>
            {applyRes.backup && <ResultCard title="Pre-apply backup" result={applyRes.backup} tone="apply" />}
            <ResultCard title="Apply" result={applyRes.apply} tone="apply" />
          </>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <header className="flex items-center gap-2">
          <Undo2 className="h-4 w-4 text-amber-500" />
          <h2 className="text-sm font-semibold">Rollback a specific version</h2>
        </header>
        <p className="text-xs text-muted-foreground">
          Enter a 4-digit migration number (e.g. <code>0041</code>). Everything applied <em>above</em> it will be undone in reverse order — but only if the matching <code>down.sql</code> exists on disk. Pluto Ops runs a pre-rollback backup automatically.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input value={rollbackTarget} onChange={(e) => setRollbackTarget(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
            placeholder="0041" className="w-32 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono" />
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={allowMissingDown} onChange={(e) => setAllowMissingDown(e.target.checked)} />
            allow missing down (destructive)
          </label>
          <button disabled={busy !== null || !/^[0-9]{1,6}$/.test(rollbackTarget)}
            onClick={() => run("rb-plan", () => rbPlan({ data: { env, target: rollbackTarget, allowMissingDown } }), setRbPlanRes)}
            className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-sm font-medium hover:bg-secondary/80 disabled:opacity-50">
            {busy === "rb-plan" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
            Plan rollback
          </button>
          <button disabled={busy !== null || !rbPlanRes?.ok}
            onClick={async () => {
              const c = window.prompt(`Type ${confirmRb} to revert ${env} down to (and including) migration ${rollbackTarget}.`);
              if (c !== confirmRb) return;
              await run("rb-apply", () => rbApply({ data: { env, target: rollbackTarget, allowMissingDown, confirm: confirmRb } }), setRbApplyRes);
            }}
            className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">
            {busy === "rb-apply" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
            Apply rollback
          </button>
        </div>
        <ResultCard title="Rollback plan" result={rbPlanRes} tone="roll" />
        {rbApplyRes && (
          <>
            <ResultCard title="Pre-rollback backup" result={rbApplyRes.backup} tone="roll" />
            <ResultCard title="Rollback" result={rbApplyRes.rollback} tone="roll" />
          </>
        )}
      </section>
    </div>
  );
}
