import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory, getUpstream } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/pluto-graphql")({
  component: GraphQLPage,
  head: () => ({ meta: [{ title: "Pluto GraphQL" }] }),
});

const SAMPLE = `{ health { ok service } }`;

function GraphQLPage() {
  const [projectId, setProjectId] = useState("");
  const [cfg, setCfg] = useState<any | null>(null);
  const [sdl, setSdl] = useState("");
  const [query, setQuery] = useState(SAMPLE);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [schemas, setSchemas] = useState("public");

  async function refresh() {
    if (!projectId) return;
    try {
      setCfg(await plutoApi(`/admin/v1/graphql/config?project_id=${projectId}`));
      const s = await plutoApi<any>(`/admin/v1/graphql/sdl?project_id=${projectId}`);
      setSdl(s.sdl); setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function enable() {
    try {
      await plutoApi(`/admin/v1/graphql/enable`, {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, schemas: schemas.split(",").map((s) => s.trim()) }),
      });
      pushUiHistory({ action: "graphql.enable", ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }

  async function run() {
    try {
      const r = await plutoApi(`/graphql/v1/${projectId}`, {
        method: "POST", body: JSON.stringify({ query }),
      });
      setResult(r);
    } catch (e: any) { setErr(e.message); }
  }

  const url = getUpstream().url;
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">GraphQL</h1>
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{err}</div>}

      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col text-xs">Project ID
          <input value={projectId} onChange={(e) => setProjectId(e.target.value)}
            className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm w-[320px]" placeholder="uuid" />
        </label>
        <label className="flex flex-col text-xs">Schemas (csv)
          <input value={schemas} onChange={(e) => setSchemas(e.target.value)}
            className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm w-[200px]" />
        </label>
        <button disabled={!projectId} onClick={enable} className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2 disabled:opacity-50">
          Enable / rebuild schema
        </button>
      </div>

      {cfg && (
        <div className="text-xs text-muted-foreground">
          Endpoint: <code className="bg-muted px-1 rounded">{url}/graphql/v1/{projectId}</code>
          {" · schemas: "}<code>{(cfg.schemas || []).join(", ")}</code>
        </div>
      )}

      <section className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Query</h2>
          <textarea value={query} onChange={(e) => setQuery(e.target.value)}
            className="w-full h-[280px] rounded-md border bg-background px-3 py-2 text-xs font-mono" />
          <button onClick={run} disabled={!projectId} className="rounded-md border text-sm px-3 py-2">Run</button>
          <pre className="bg-muted/40 p-2 text-xs rounded max-h-[220px] overflow-auto">{JSON.stringify(result, null, 2)}</pre>
        </div>
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Schema SDL</h2>
          <pre className="bg-muted/40 p-2 text-xs rounded h-[420px] overflow-auto">{sdl || "—"}</pre>
        </div>
      </section>
    </div>
  );
}
