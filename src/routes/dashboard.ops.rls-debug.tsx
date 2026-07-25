import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Loader2, PlayCircle, ShieldAlert, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";
import { pluto } from "@/lib/pluto/client";
import {
  adaptExplainJson, adaptPolicyRows, buildExplain, buildPoliciesQuery,
  buildRlsStateQuery, extractTables, type PlanNode, type PolicyRow,
} from "@/lib/pluto/db-diagnostics";

export const Route = createFileRoute("/dashboard/ops/rls-debug")({
  component: RlsDebugPage,
  head: () => ({
    meta: [
      { title: "RLS policy debugger — Pluto BaaS" },
      { name: "description", content: "See exactly why a query was allowed or denied — which pg_policies matched, and how each USING / WITH CHECK expression evaluated for the current session." },
      { property: "og:title", content: "RLS policy debugger — Pluto BaaS" },
      { property: "og:description", content: "Trace RLS decisions on Pluto BaaS with the matching policies and evaluated USING/WITH CHECK conditions." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

const EXAMPLE = `select id, title from public.posts where workspace_id = auth.workspace() limit 5`;

type ClauseEval = {
  policy: string;
  clause: "USING" | "WITH CHECK";
  expr: string;
  value: boolean | null;
  error: string | null;
};

type DebugResult = {
  tables: string[];
  rlsState: Array<{ schemaname: string; tablename: string; enabled: boolean; forced: boolean }>;
  policies: PolicyRow[];
  planTree: PlanNode | null;
  executionOk: boolean;
  executionError: string | null;
  executionRows: number | null;
  clauseEvals: ClauseEval[];
  verdict: "allowed" | "denied" | "no-rls" | "unknown";
  verdictReason: string;
};

function RlsDebugPage() {
  return (
    <TraceAccessGate permission="manage">
      <RlsDebugInner />
    </TraceAccessGate>
  );
}

function RlsDebugInner() {
  const [sql, setSql] = useState(EXAMPLE);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DebugResult | null>(null);
  const tables = useMemo(() => extractTables(sql), [sql]);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      
      // 1. Try to actually run the query as the current session to observe the outcome.
      let executionOk = false; let executionError: string | null = null; let executionRows: number | null = null;
      try {
        const r = await pluto.db.runSql(sql.trim().replace(/;+\s*$/, ""));
        executionOk = true;
        executionRows = r.rows?.length ?? 0;
      } catch (e) { executionError = e instanceof Error ? e.message : String(e); }

      // 2. Collect the query's plan for join/filter context.
      let planTree: PlanNode | null = null;
      try {
        const p = await pluto.db.runSql(buildExplain(sql, false));
        const raw = p.rows?.[0]?.[0];
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        planTree = adaptExplainJson(parsed);
      } catch { /* explain failure is non-fatal for RLS debugging */ }

      // 3. Load pg_policies for every referenced table.
      const [polRes, rlsRes] = await Promise.all([
        tables.length ? pluto.db.runSql(buildPoliciesQuery(tables)) : Promise.resolve({ columns: [], rows: [] }),
        tables.length ? pluto.db.runSql(buildRlsStateQuery(tables)) : Promise.resolve({ columns: [], rows: [] }),
      ]);
      const policies = adaptPolicyRows(polRes);
      const rlsState = rlsRes.rows.map((r: unknown[]) => ({
        schemaname: String(r[rlsRes.columns.indexOf("schemaname")] ?? ""),
        tablename: String(r[rlsRes.columns.indexOf("tablename")] ?? ""),
        enabled: r[rlsRes.columns.indexOf("rls_enabled")] === true,
        forced: r[rlsRes.columns.indexOf("rls_forced")] === true,
      }));

      // 4. For each policy clause, evaluate it as a standalone SELECT so we
      //    see the boolean the planner would have produced. We rewrite
      //    `select (<expr>)::boolean` inside the same session.
      const clauseEvals: ClauseEval[] = [];
      for (const pol of policies) {
        for (const [clause, expr] of ([["USING", pol.qual], ["WITH CHECK", pol.with_check]] as const)) {
          if (!expr) continue;
          try {
            const r = await pluto.db.runSql(`select (${expr})::boolean as v`);
            const v = r.rows?.[0]?.[0];
            clauseEvals.push({ policy: `${pol.schemaname}.${pol.tablename}·${pol.policyname}`, clause, expr, value: typeof v === "boolean" ? v : null, error: null });
          } catch (e) {
            clauseEvals.push({ policy: `${pol.schemaname}.${pol.tablename}·${pol.policyname}`, clause, expr, value: null, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }

      // 5. Compute verdict.
      const noRls = rlsState.length > 0 && rlsState.every((r) => !r.enabled);
      let verdict: DebugResult["verdict"] = "unknown";
      let verdictReason = "";
      if (noRls) { verdict = "no-rls"; verdictReason = "RLS is disabled on every referenced table — Postgres will return rows unconditionally to any grantee."; }
      else if (executionOk) {
        const allowingPol = clauseEvals.find((c) => c.clause === "USING" && c.value === true);
        verdict = "allowed";
        verdictReason = allowingPol
          ? `Query succeeded (${executionRows} rows). Permissive USING clause of ${allowingPol.policy} evaluated to TRUE for the current session.`
          : `Query succeeded (${executionRows} rows). No explicit USING clause was found — check if RLS is bypassed by role or if a matching policy exists for a joined table.`;
      } else if (executionError && /row-level security|permission denied|policy/i.test(executionError)) {
        verdict = "denied";
        const failing = clauseEvals.filter((c) => c.clause === "USING" && c.value !== true);
        verdictReason = failing.length
          ? `Denied by RLS. USING clauses that did NOT evaluate to TRUE: ${failing.map((f) => f.policy).join(", ")}.`
          : `Denied by RLS but no matching policy for this role. Add a permissive SELECT policy, or grant a role that has one.`;
      } else if (executionError) {
        verdict = "unknown";
        verdictReason = `Non-RLS error prevented evaluation: ${executionError}`;
      }

      setResult({ tables, rlsState, policies, planTree, executionOk, executionError, executionRows, clauseEvals, verdict, verdictReason });
    } finally { setBusy(false); }
  }, [sql, tables]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/dashboard/ops" search={{ env: "prod" }} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Operations
        </Link>
      </div>

      <PageHeader
        title="RLS policy debugger"
        description="Paste a query — Pluto runs it as the current session, then evaluates every matching USING / WITH CHECK expression to explain why the row was allowed or denied."
      />

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={6} spellCheck={false}
          className="w-full rounded-md border border-border bg-background p-3 font-mono text-xs" />
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted-foreground">Referenced tables: {tables.length ? tables.map((t) => <code key={t} className="mx-1">{t}</code>) : "—"}</div>
          <button onClick={run} disabled={busy}
            className="ml-auto inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            Debug
          </button>
        </div>
      </section>

      {result && (
        <>
          <section className={`rounded-lg border p-4 ${result.verdict === "allowed" ? "border-emerald-500/40 bg-emerald-500/10" : result.verdict === "denied" ? "border-destructive/40 bg-destructive/10" : "border-amber-500/40 bg-amber-500/10"}`}>
            <div className="flex items-center gap-2">
              {result.verdict === "allowed" ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> :
               result.verdict === "denied"  ? <XCircle className="h-5 w-5 text-destructive" /> :
               <ShieldAlert className="h-5 w-5 text-amber-500" />}
              <h2 className="text-sm font-semibold uppercase">Verdict: {result.verdict}</h2>
            </div>
            <p className="mt-1 text-sm">{result.verdictReason}</p>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 space-y-2">
            <h2 className="text-sm font-semibold">RLS state per table</h2>
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr><th className="text-left py-1 pr-3">Table</th><th className="text-left py-1 pr-3">RLS</th><th className="text-left py-1">FORCE</th></tr>
              </thead>
              <tbody>
                {result.rlsState.map((r) => (
                  <tr key={`${r.schemaname}.${r.tablename}`} className="border-t border-border/50">
                    <td className="py-1 pr-3 font-mono">{r.schemaname}.{r.tablename}</td>
                    <td className="py-1 pr-3">{r.enabled ? "enabled" : <span className="text-destructive">disabled</span>}</td>
                    <td className="py-1">{r.forced ? "forced" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 space-y-2">
            <h2 className="text-sm font-semibold">Policy clause evaluation ({result.clauseEvals.length})</h2>
            <p className="text-xs text-muted-foreground">Each clause is re-evaluated as a standalone <code>select (expr)::boolean</code> under your current session's JWT so you can see exactly what the planner saw.</p>
            <div className="space-y-2">
              {result.clauseEvals.map((c, i) => (
                <div key={i} className="rounded border border-border p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold">{c.policy}</span>
                    <span className="rounded bg-secondary px-1.5 py-0.5">{c.clause}</span>
                    <span className={`rounded px-1.5 py-0.5 ml-auto ${c.value === true ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400" : c.value === false ? "bg-destructive/20 text-destructive" : "bg-muted"}`}>
                      → {c.value === null ? (c.error ? "error" : "?") : String(c.value)}
                    </span>
                  </div>
                  <pre className="mt-1 font-mono whitespace-pre-wrap">{c.expr}</pre>
                  {c.error && <p className="text-destructive text-xs mt-1">{c.error}</p>}
                </div>
              ))}
              {!result.clauseEvals.length && <p className="text-xs text-muted-foreground">No policies found for the referenced tables.</p>}
            </div>
          </section>

          {result.executionError && (
            <section className="rounded-lg border border-border bg-card p-4 space-y-1">
              <h2 className="text-sm font-semibold">Raw execution error</h2>
              <pre className="text-xs font-mono whitespace-pre-wrap text-destructive">{result.executionError}</pre>
            </section>
          )}
        </>
      )}
    </div>
  );
}
