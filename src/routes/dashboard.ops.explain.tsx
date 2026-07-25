import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, Loader2, PlayCircle, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";
import { pluto } from "@/lib/pluto/client";
import {
  adaptExplainJson, adaptPolicyRows, buildExplain, buildPoliciesQuery,
  buildRlsStateQuery, extractTables, findRlsHints,
  type PlanNode, type PolicyRow,
} from "@/lib/pluto/db-diagnostics";

export const Route = createFileRoute("/dashboard/ops/explain")({
  component: ExplainPage,
  head: () => ({
    meta: [
      { title: "EXPLAIN analyzer — Pluto BaaS" },
      { name: "description", content: "Run EXPLAIN / EXPLAIN (ANALYZE) for a REST or SQL query and see which tables, joins, indexes, and RLS policies are involved." },
      { property: "og:title", content: "EXPLAIN analyzer — Pluto BaaS" },
      { property: "og:description", content: "Performance + access debugging in one view: plan tree, RLS filters, and matching pg_policies rows for every referenced table." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

const EXAMPLE = `select p.id, p.title
from public.posts p
join public.profiles u on u.id = p.owner_id
where p.workspace_id = auth.workspace()
order by p.created_at desc
limit 20`;

type ExplainState = {
  planTree: PlanNode | null;
  totalMs: number | null;
  policies: PolicyRow[];
  rlsState: Array<{ schemaname: string; tablename: string; enabled: boolean; forced: boolean }>;
  tables: string[];
  rlsHints: string[];
  error: string | null;
};

function ExplainPage() {
  return (
    <TraceAccessGate permission="manage">
      <ExplainInner />
    </TraceAccessGate>
  );
}

function ExplainInner() {
  const [sql, setSql] = useState(EXAMPLE);
  const [analyze, setAnalyze] = useState(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ExplainState | null>(null);

  const tables = useMemo(() => extractTables(sql), [sql]);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      
      let explainSql: string;
      try { explainSql = buildExplain(sql, analyze); }
      catch (e) { setState({ planTree: null, totalMs: null, policies: [], rlsState: [], tables, rlsHints: [], error: (e as Error).message }); return; }
      const explainRes = await pluto.db.runSql(explainSql);
      // Postgres returns EXPLAIN JSON as a single row/column containing the JSON.
      const raw = explainRes.rows?.[0]?.[0];
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      const planTree = adaptExplainJson(parsed);
      const totalMs = planTree?.actualTimeMs?.total ?? null;

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
      const rlsHints = planTree ? findRlsHints(planTree) : [];
      setState({ planTree, totalMs, policies, rlsState, tables, rlsHints, error: null });
    } catch (e) {
      setState({ planTree: null, totalMs: null, policies: [], rlsState: [], tables, rlsHints: [], error: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  }, [sql, analyze, tables]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/dashboard/ops" search={{ env: "prod" }} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Operations
        </Link>
      </div>

      <PageHeader
        title="EXPLAIN / ANALYZE query analyzer"
        description="Paste the SQL a REST call would run — Pluto shows the plan tree, join/index usage, actual runtime, and which pg_policies rows apply to every referenced table."
      />

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={8}
          spellCheck={false}
          className="w-full rounded-md border border-border bg-background p-3 font-mono text-xs" />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={analyze} onChange={(e) => setAnalyze(e.target.checked)} />
            EXPLAIN (ANALYZE) — <span className="text-muted-foreground">actually runs the query</span>
          </label>
          <button onClick={run} disabled={busy}
            className="ml-auto inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
            Run
          </button>
        </div>
        <div className="text-xs text-muted-foreground">
          Referenced tables (best-effort): {tables.length ? tables.map((t) => <code key={t} className="mx-1">{t}</code>) : "—"}
        </div>
      </section>

      {state?.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {state.error}
        </div>
      )}

      {state?.planTree && (
        <section className="rounded-lg border border-border bg-card p-4 space-y-2">
          <header className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2"><Sparkles className="h-4 w-4" /> Plan tree</h2>
            {state.totalMs != null && <span className="text-xs text-muted-foreground">actual: {state.totalMs.toFixed(2)} ms</span>}
          </header>
          <PlanTree node={state.planTree} depth={0} />
          {state.rlsHints.length > 0 && (
            <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
              <div className="font-semibold mb-1">RLS filters detected in plan:</div>
              <ul className="space-y-0.5 font-mono">
                {state.rlsHints.map((h, i) => <li key={i}>• {h}</li>)}
              </ul>
            </div>
          )}
        </section>
      )}

      {state && state.tables.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4 space-y-2">
          <h2 className="text-sm font-semibold">Row-level security state</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr><th className="text-left py-1 pr-3">Table</th><th className="text-left py-1 pr-3">RLS enabled</th><th className="text-left py-1">FORCE</th></tr>
              </thead>
              <tbody>
                {state.rlsState.map((r) => (
                  <tr key={`${r.schemaname}.${r.tablename}`} className="border-t border-border/50">
                    <td className="py-1 pr-3 font-mono">{r.schemaname}.{r.tablename}</td>
                    <td className="py-1 pr-3">{r.enabled ? "yes" : <span className="text-destructive">no</span>}</td>
                    <td className="py-1">{r.forced ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {state && state.policies.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4 space-y-2">
          <h2 className="text-sm font-semibold">Matching pg_policies rows ({state.policies.length})</h2>
          <div className="space-y-2">
            {state.policies.map((p) => (
              <div key={`${p.schemaname}.${p.tablename}.${p.policyname}`} className="rounded border border-border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="font-mono font-semibold">{p.schemaname}.{p.tablename}</span>
                  <span className="rounded bg-secondary px-1.5 py-0.5">{p.cmd}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5">{p.permissive}</span>
                  <span className="text-muted-foreground">roles: {p.roles.join(", ") || "public"}</span>
                  <span className="text-muted-foreground ml-auto">{p.policyname}</span>
                </div>
                {p.qual && <div className="font-mono"><span className="text-muted-foreground">USING</span> {p.qual}</div>}
                {p.with_check && <div className="font-mono"><span className="text-muted-foreground">WITH CHECK</span> {p.with_check}</div>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function PlanTree({ node, depth }: { node: PlanNode; depth: number }) {
  return (
    <div style={{ paddingLeft: depth * 16 }} className="font-mono text-xs">
      <div className="flex flex-wrap items-baseline gap-2 py-0.5">
        <span className="font-semibold">{node.nodeType}</span>
        {node.relation && <span className="text-muted-foreground">on {node.relation}{node.alias && node.alias !== node.relation ? ` (${node.alias})` : ""}</span>}
        {node.indexName && <span className="text-blue-500">using {node.indexName}</span>}
        <span className="text-muted-foreground ml-auto">cost={node.cost.startup.toFixed(1)}..{node.cost.total.toFixed(1)}{node.actualTimeMs ? ` · ${node.actualTimeMs.total.toFixed(2)}ms · ${node.actualRows}r × ${node.actualLoops}` : ""}</span>
      </div>
      {node.filter && <div className="text-amber-600 dark:text-amber-400 pl-4">filter: {node.filter}</div>}
      {node.children.map((c, i) => <PlanTree key={i} node={c} depth={depth + 1} />)}
    </div>
  );
}
