import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Play, Sparkles, Info } from "lucide-react";
import { toast } from "sonner";
import { api, isLive } from "@/lib/pluto/live";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/graphql")({
  head: () => ({
    meta: [
      { title: "GraphQL Explorer — Pluto" },
      { name: "description", content: "Interactively query the auto-generated GraphQL API with your workspace credentials." },
    ],
  }),
  component: GraphqlPage,
});

const EXAMPLES: { label: string; query: string }[] = [
  {
    label: "List rows with filter + order + limit",
    query: `query ListTodos {
  todos(where: { done: { eq: false } }, order: "created_at.desc", limit: 10) {
    id
    title
    created_at
  }
}`,
  },
  {
    label: "Insert one row",
    query: `mutation NewTodo {
  insert_todos(objects: [{ title: "buy milk" }]) {
    id
    title
  }
}`,
  },
  {
    label: "Update by id",
    query: `mutation Complete($id: ID!) {
  update_todos(where: { id: { eq: $id } }, set: { done: true }) {
    id
    done
  }
}`,
  },
];

function GraphqlPage() {
  const [query, setQuery]     = useState(EXAMPLES[0].query);
  const [variables, setVars]  = useState("{}");
  const [result, setResult]   = useState<string>("");
  const [busy, setBusy]       = useState(false);
  const [status, setStatus]   = useState<"idle" | "ok" | "err">("idle");

  async function run() {
    if (!isLive()) { toast.error("Backend not configured"); return; }
    let vars: Record<string, unknown> = {};
    if (variables.trim()) {
      try { vars = JSON.parse(variables); }
      catch { toast.error("Variables is not valid JSON"); return; }
    }
    setBusy(true); setStatus("idle");
    try {
      // Reuses api() from live.ts, which already attaches
      //   apikey: <anon/service>       (workspace + role selection)
      //   Authorization: Bearer <jwt>  (RLS identity — `pluto.user_id`)
      // Nothing extra is needed here — the same headers your dashboard
      // sends on every request are what /graphql/v1 sees.
      const res = await api<{ data?: unknown; errors?: { message: string }[] }>(
        "/graphql/v1",
        { method: "POST", body: JSON.stringify({ query, variables: vars }) },
      );
      setResult(JSON.stringify(res, null, 2));
      setStatus(res.errors && res.errors.length ? "err" : "ok");
    } catch (e) {
      setStatus("err");
      setResult(String((e as Error).message));
    } finally { setBusy(false); }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Sparkles className="h-5 w-5" /> GraphQL Explorer
        </h1>
      <AutoHelpPanel slug={'dashboard.graphql'} title={'GraphQL Explorer'} description={''} />
        <p className="text-sm text-muted-foreground">
          Send GraphQL queries against <code>/graphql/v1</code> using your current session.
        </p>
      </div>

      {!isLive() && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs">
          Set <code>VITE_PLUTO_URL</code> and <code>VITE_PLUTO_ANON_KEY</code> to run queries.
        </div>
      )}

      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Info className="h-4 w-4" /> How Row-Level Security is applied
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-2">
          <p>
            Every request opens a Postgres transaction and runs{" "}
            <code>select set_config('pluto.user_id', &lt;your uid&gt;, true)</code> before
            the generated SQL executes. Your table's RLS policies see the same
            <code> current_setting('pluto.user_id') </code> value as they would
            through the REST surface.
          </p>
          <p>
            The <code>apikey</code> header picks the role: <b>anon</b> is subject to
            all policies, <b>service_role</b> bypasses RLS. Rejected rows raise a
            <code> 42501 </code> Postgres error, which appears in the GraphQL
            <code> errors[] </code> array and the transaction is rolled back — you
            never see partial writes.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between">
              <span>Query</span>
              <div className="flex gap-1">
                {EXAMPLES.map((ex) => (
                  <Button key={ex.label} size="sm" variant="ghost" className="h-6 text-[10px]"
                          onClick={() => setQuery(ex.query)} title={ex.label}>
                    {ex.label.split(" ").slice(0, 2).join(" ")}
                  </Button>
                ))}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea value={query} onChange={(e) => setQuery(e.target.value)}
                      className="font-mono text-xs min-h-[240px]" spellCheck={false} />
            <div>
              <div className="text-[10px] text-muted-foreground mb-1">Variables (JSON)</div>
              <Textarea value={variables} onChange={(e) => setVars(e.target.value)}
                        className="font-mono text-xs min-h-[80px]" spellCheck={false} />
            </div>
            <Button size="sm" onClick={run} disabled={busy}>
              <Play className="h-3 w-3 mr-1" /> {busy ? "Running…" : "Run query"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              Response
              {status === "ok"  && <span className="text-[10px] text-green-500">success</span>}
              {status === "err" && <span className="text-[10px] text-red-500">errors</span>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="font-mono text-xs bg-muted rounded-md p-3 min-h-[340px] overflow-auto whitespace-pre-wrap">
              {result || "// Response will appear here"}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
