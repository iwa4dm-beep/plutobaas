import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, CheckCircle2, Cpu, Loader2, Network, ServerCog, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";
import { runDockerCheck, type DockerCheckReport } from "@/lib/pluto/docker-check.functions";

export const Route = createFileRoute("/dashboard/ops/docker-check")({
  component: DockerCheckPage,
  head: () => ({
    meta: [
      { title: "Docker connectivity checker — Pluto Ops" },
      { name: "description", content: "Verify container-to-container DNS, required ports, and the effective DATABASE_URL each Pluto BaaS container sees, on VPS or local Docker." },
      { property: "og:title", content: "Docker connectivity checker — Pluto Ops" },
      { property: "og:description", content: "Diagnose Pluto BaaS Docker networking, ports, and per-container DATABASE_URL." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function DockerCheckPage() {
  return (
    <TraceAccessGate permission="manage">
      <DockerCheckInner />
    </TraceAccessGate>
  );
}

function Tick({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-label="ok" />
    : <XCircle className="h-4 w-4 text-destructive" aria-label="fail" />;
}

function DockerCheckInner() {
  const [scope, setScope] = useState<"vps" | "local">("vps");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<DockerCheckReport | null>(null);
  const fn = useServerFn(runDockerCheck);

  const run = useCallback(async () => {
    setBusy(true);
    try { setReport(await fn({ data: { scope } })); } finally { setBusy(false); }
  }, [fn, scope]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/dashboard/ops" search={{ env: "prod" }} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Operations
        </Link>
      </div>

      <PageHeader
        title="Docker connectivity checker"
        subtitle="Container-to-container DNS, required ports, and effective DATABASE_URL as each container sees it — for both VPS and local Docker."
      />

      <section className="rounded-lg border border-border bg-card p-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-muted-foreground">Scope</label>
        {(["vps", "local"] as const).map((s) => (
          <button key={s} onClick={() => setScope(s)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium border ${s === scope ? "bg-primary text-primary-foreground border-primary" : "bg-card hover:bg-accent border-border"}`}>
            {s}
          </button>
        ))}
        <button onClick={run} disabled={busy}
          className="ml-auto inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ServerCog className="h-4 w-4" />}
          Run checks
        </button>
      </section>

      {report && (
        <>
          <section className="rounded-lg border border-border bg-card p-4 space-y-2">
            <header className="flex items-center justify-between">
              <h2 className="text-sm font-semibold flex items-center gap-2"><Cpu className="h-4 w-4" /> Compose services · {report.compose.project ?? "(no project)"}</h2>
              <span className="text-xs text-muted-foreground">host: {report.hostname} · {report.durationMs}ms</span>
            </header>
            {report.hint && <p className="text-xs rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-600 dark:text-amber-400">{report.hint}</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr><th className="text-left py-1 pr-3">Service</th><th className="text-left py-1 pr-3">State</th><th className="text-left py-1 pr-3">Health</th><th className="text-left py-1">Ports</th></tr>
                </thead>
                <tbody>
                  {report.compose.services.map((s) => (
                    <tr key={s.name} className="border-t border-border/50">
                      <td className="py-1 pr-3 font-mono">{s.name}</td>
                      <td className="py-1 pr-3">{s.state}</td>
                      <td className="py-1 pr-3">{s.health ?? "—"}</td>
                      <td className="py-1 font-mono text-muted-foreground">{s.ports || "—"}</td>
                    </tr>
                  ))}
                  {!report.compose.services.length && <tr><td colSpan={4} className="py-2 text-muted-foreground">No services reported.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 space-y-2">
            <h2 className="text-sm font-semibold flex items-center gap-2"><Network className="h-4 w-4" /> Container DNS resolution</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr><th className="w-10"></th><th className="text-left py-1 pr-3">From</th><th className="text-left py-1 pr-3">Target</th><th className="text-left py-1">Resolved</th></tr>
                </thead>
                <tbody>
                  {report.dns.map((d, i) => (
                    <tr key={i} className="border-t border-border/50">
                      <td className="py-1 pl-1"><Tick ok={d.ok} /></td>
                      <td className="py-1 pr-3 font-mono">{d.from}</td>
                      <td className="py-1 pr-3 font-mono">{d.target}</td>
                      <td className="py-1 font-mono text-muted-foreground">{d.resolved ?? "—"}</td>
                    </tr>
                  ))}
                  {!report.dns.length && <tr><td colSpan={4} className="py-2 text-muted-foreground">No DNS probes recorded.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 space-y-2">
            <h2 className="text-sm font-semibold">Required ports</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
              {report.ports.map((p, i) => (
                <div key={i} className="flex items-center gap-2 rounded border border-border px-2 py-1.5">
                  <Tick ok={p.reachable} />
                  <span className="font-mono">{p.container}:{p.port}</span>
                  <span className="text-muted-foreground ml-auto">{p.via}</span>
                </div>
              ))}
              {!report.ports.length && <p className="text-muted-foreground">No port checks recorded.</p>}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 space-y-2">
            <h2 className="text-sm font-semibold">Effective DATABASE_URL (redacted)</h2>
            <p className="text-xs text-muted-foreground">Passwords are replaced with <code>***</code>. Compare across containers — mismatched hosts or ports are the usual root cause of connection failures.</p>
            <div className="space-y-1 text-xs">
              {report.env.databaseUrl.map((r, i) => (
                <div key={i} className="flex items-center gap-2 rounded border border-border px-2 py-1.5">
                  <span className="font-mono text-muted-foreground">[{r.source}]</span>
                  <span className="font-mono">{r.container}</span>
                  <span className="font-mono text-muted-foreground ml-auto truncate max-w-[60%]">{r.url ?? "(unset)"}</span>
                </div>
              ))}
              {!report.env.databaseUrl.length && <p className="text-muted-foreground">No DATABASE_URL captured.</p>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs pt-2 border-t border-border/50">
              <div><span className="text-muted-foreground mr-2">PLUTO_URL:</span><code>{report.env.plutoUrl ?? "—"}</code></div>
              <div><span className="text-muted-foreground mr-2">SUPABASE_URL:</span><code>{report.env.supabaseUrl ?? "—"}</code></div>
            </div>
          </section>

          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Show raw command output</summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap font-mono">{report.tail || "(empty)"}</pre>
          </details>
        </>
      )}
    </div>
  );
}
