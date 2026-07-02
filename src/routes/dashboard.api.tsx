// Auto-generated REST endpoint browser.
//
// Reads the backend's schema introspection (backend/apps/server/src/
// modules/admin/schema.ts) and renders one card per workspace-scoped
// table with a copy-ready curl example, the OpenAPI download link, and
// a per-row list of columns / policies. Everything here is derived —
// migrations are the single source of truth.

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Code2, Copy, Download, Lock, Radio, RefreshCw, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { RequireWorkspace } from "@/components/pluto/RequireWorkspace";
import { useWorkspace } from "@/lib/pluto/workspace-context";
import { isLive, live, type SchemaEndpoint, type SchemaTable } from "@/lib/pluto/live";
import { generateTypedClient } from "@/lib/pluto/gen-client";

export const Route = createFileRoute("/dashboard/api")({
  component: () => <RequireWorkspace><ApiEndpointsPage /></RequireWorkspace>,
});

function ApiEndpointsPage() {
  const { active } = useWorkspace();
  const backendOk = isLive();
  const [tables,    setTables]    = useState<SchemaTable[]>([]);
  const [endpoints, setEndpoints] = useState<SchemaEndpoint[]>([]);
  const [error,     setError]     = useState<string | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [filter,    setFilter]    = useState("");

  const base = (typeof window !== "undefined"
    ? (import.meta.env.VITE_PLUTO_URL ?? window.location.origin)
    : "");

  const load = useCallback(async () => {
    if (!backendOk) return;
    setLoading(true); setError(null);
    try {
      const [intro, summary] = await Promise.all([
        live.schema.introspect(),
        live.schema.summary(),
      ]);
      setTables(intro.tables);
      setEndpoints(summary.endpoints);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [backendOk]);

  useEffect(() => { void load(); }, [load]);

  const merged = useMemo(() => {
    // Join endpoint metadata onto the richer table introspection so
    // one row has methods, columns, and policies together.
    const byName = new Map(tables.map((t) => [t.name, t]));
    const rows = endpoints.map((e) => ({ endpoint: e, table: byName.get(e.table) }));
    if (!filter.trim()) return rows;
    const q = filter.toLowerCase();
    return rows.filter((r) => r.endpoint.table.toLowerCase().includes(q));
  }, [tables, endpoints, filter]);

  const openapiUrl = `${base.replace(/\/$/, "")}/admin/v1/schema/openapi.json`;

  return (
    <div>
      <PageHeader
        title="REST endpoints"
        description="Auto-generated from your live SQL schema. Each workspace-scoped table becomes a PostgREST-style resource under /rest/v1/. Refresh after new migrations to pick up changes."
        actions={
          <div className="flex gap-2">
            <a
              href={openapiUrl}
              target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm rounded-md border border-border px-3 py-1.5 hover:bg-accent"
            >
              <Download className="h-3.5 w-3.5" /> OpenAPI
            </a>
            <button
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 text-sm rounded-md border border-border px-3 py-1.5 hover:bg-accent"
            >
              <RefreshCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} /> Refresh
            </button>
          </div>
        }
      />

      {!backendOk && (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5" />
          Backend not configured — set <code>VITE_PLUTO_URL</code> and an API key to view live endpoints.
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="mb-4 flex items-center gap-2 text-sm">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables…"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm w-64 outline-none focus:border-primary"
        />
        <span className="text-xs text-muted-foreground">
          {merged.length} endpoint{merged.length === 1 ? "" : "s"} · workspace {active.slug}
        </span>
      </div>

      <div className="space-y-3">
        {merged.map(({ endpoint, table }) => (
          <EndpointCard key={endpoint.table} endpoint={endpoint} table={table} base={base} workspaceSlug={active.slug} />
        ))}
        {!loading && merged.length === 0 && (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No endpoints found. Add a table via a migration and refresh.
          </div>
        )}
      </div>
    </div>
  );
}

function EndpointCard({
  endpoint, table, base, workspaceSlug,
}: {
  endpoint: SchemaEndpoint;
  table: SchemaTable | undefined;
  base: string;
  workspaceSlug: string;
}) {
  const [copied, setCopied] = useState(false);

  const curl = useMemo(() => {
    const url = `${base.replace(/\/$/, "")}${endpoint.base}?select=*&limit=10`;
    return [
      `curl '${url}' \\`,
      `  -H 'apikey: <ANON_OR_SERVICE_KEY>' \\`,
      `  -H 'Authorization: Bearer <USER_JWT>'`,
    ].join("\n");
  }, [base, endpoint.base]);

  const doCopy = () => {
    void navigator.clipboard.writeText(curl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <details className="rounded-lg border border-border bg-card overflow-hidden group" open={false}>
      <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-accent/40 list-none">
        <Radio className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="font-mono text-sm font-medium">{endpoint.base}</code>
            {endpoint.workspace_scoped && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                workspace: {workspaceSlug}
              </span>
            )}
            {endpoint.rls_enabled ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 inline-flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" /> RLS
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-300 inline-flex items-center gap-1">
                <Lock className="h-3 w-3" /> no RLS
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">
            {endpoint.methods.join(" · ")} · pk: {endpoint.primary_key.join(", ") || "—"} · {endpoint.columns.length} cols
          </div>
        </div>
      </summary>

      <div className="border-t border-border px-4 py-3 grid md:grid-cols-2 gap-4 text-xs">
        <div>
          <div className="text-[11px] uppercase text-muted-foreground mb-1">Columns</div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {table?.columns.map((c) => (
              <div key={c.name} className="flex items-center gap-2">
                <code className="font-mono">{c.name}</code>
                <span className="text-muted-foreground">{c.udt_name}</span>
                {c.is_primary_key && <span className="text-[10px] text-primary">PK</span>}
                {!c.is_nullable && <span className="text-[10px] text-muted-foreground">not null</span>}
                {c.references && (
                  <span className="text-[10px] text-muted-foreground">→ {c.references.table}.{c.references.column}</span>
                )}
              </div>
            )) ?? <div className="text-muted-foreground italic">no introspection available</div>}
          </div>
          {table && table.policies.length > 0 && (
            <>
              <div className="text-[11px] uppercase text-muted-foreground mt-3 mb-1">Policies</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {table.policies.map((p) => <li key={p} className="font-mono">{p}</li>)}
              </ul>
            </>
          )}
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-[11px] uppercase text-muted-foreground">Example</div>
            <button
              onClick={doCopy}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Copy className="h-3 w-3" />
              {copied ? "copied" : "copy"}
            </button>
          </div>
          <pre className="bg-background border border-border rounded p-2 font-mono text-[11px] leading-4 overflow-x-auto whitespace-pre">
{curl}
          </pre>
          <div className="mt-2 text-[11px] text-muted-foreground">
            Filters: <code>?column=eq.value</code>, <code>?column=in.(a,b)</code>,{" "}
            <code>?order=col.desc</code>, <code>?limit=25&amp;offset=50</code>.
          </div>
        </div>
      </div>
    </details>
  );
}
