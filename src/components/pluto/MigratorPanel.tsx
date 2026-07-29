// Pluto Migrator panel — lists signed import jobs sent by the Chrome
// extension and lets an admin translate / dry-run / apply each migration.
import { useCallback, useEffect, useState } from "react";
import { Download, Play, RefreshCw, ShieldCheck, Wand2 } from "lucide-react";
import {
  applyImportJob,
  dryRunImportJob,
  listImportJobsFn,
  retranslateImportJob,
  type ImportJobView,
  type SqlOutcome,
} from "@/lib/pluto/import-job.functions";

const EXT_ZIP = "/downloads/pluto-migrator-extension.zip";

function statusTone(s: string) {
  if (s === "applied" || s === "dry_run_ok") return "bg-primary/10 text-primary";
  if (s.endsWith("failed")) return "bg-destructive/10 text-destructive";
  return "bg-muted text-muted-foreground";
}

export function MigratorPanel() {
  const [jobs, setJobs] = useState<ImportJobView[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openSql, setOpenSql] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Record<string, SqlOutcome>>({});

  const refresh = useCallback(async () => {
    setBusy("list");
    try {
      const r = await listImportJobsFn();
      if (!r.ok) setErr(r.error ?? "Failed to load import jobs");
      else { setErr(null); setJobs(r.jobs); }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function run(kind: "translate" | "dry" | "apply", job: ImportJobView) {
    setBusy(`${kind}:${job.id}`);
    try {
      if (kind === "translate") {
        const r = await retranslateImportJob({ data: { id: job.id } });
        if (!r.ok) setErr(r.error);
        else setOpenSql(r.sql);
      } else if (kind === "dry") {
        setOutcome((o) => ({ ...o, [job.id]: await dryRunImportJob({ data: { id: job.id } }) }));
      } else {
        if (!confirm(`Apply migration for ${job.repo ?? job.event_id} to the live Pluto database?`)) return;
        setOutcome((o) => ({ ...o, [job.id]: await applyImportJob({ data: { id: job.id, confirm: true } }) }));
      }
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function downloadExtension() {
    fetch(EXT_ZIP)
      .then((r) => { if (!r.ok) throw new Error(`Download failed: ${r.status}`); return r.blob(); })
      .then((b) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = "pluto-migrator-extension.zip";
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((e) => setErr(e.message));
  }

  return (
    <section className="border rounded-lg p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium flex items-center gap-2"><Wand2 className="h-4 w-4" /> Pluto Migrator</h2>
          <p className="text-xs text-muted-foreground">
            Import a project from Lovable / GitHub / Supabase with the signed Chrome extension, then dry-run and apply the converted migration here.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-2 text-sm rounded border inline-flex items-center gap-1" onClick={downloadExtension}>
            <Download className="h-4 w-4" /> Download extension
          </button>
          <button className="px-3 py-2 text-sm rounded border inline-flex items-center gap-1" onClick={() => void refresh()} disabled={busy === "list"}>
            <RefreshCw className={`h-4 w-4 ${busy === "list" ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      <div className="text-xs text-muted-foreground border rounded p-2 flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          Endpoint <code>/api/public/pluto-import</code> · HMAC-SHA256 over <code>{"<timestamp>.<body>"}</code> with{" "}
          <code>PLUTO_IMPORT_WEBHOOK_SECRET</code> · 5-minute window · duplicate <code>event_id</code> is ignored.
        </span>
      </div>

      {err && <div className="text-sm text-destructive">{err}</div>}

      <table className="w-full text-sm border rounded overflow-hidden">
        <thead className="bg-muted">
          <tr><th className="text-left px-2 py-1">Source</th><th className="text-left">Repo / target</th><th>Status</th><th>Received</th><th></th></tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className="border-t align-top">
              <td className="px-2 py-1">{j.source}</td>
              <td className="px-2 py-1">
                <div className="truncate max-w-[22rem]">{j.repo ?? j.slug ?? "—"}</div>
                <div className="text-[11px] text-muted-foreground font-mono truncate max-w-[22rem]">{j.event_id}</div>
                {outcome[j.id] && (
                  <div className={`text-[11px] ${outcome[j.id].ok ? "text-primary" : "text-destructive"}`}>
                    {outcome[j.id].ok
                      ? `ok · ${outcome[j.id].rowCount} rows · ${outcome[j.id].durationMs}ms`
                      : `${outcome[j.id].error}${outcome[j.id].detail ? ` — ${outcome[j.id].detail.slice(0, 160)}` : ""}`}
                  </div>
                )}
              </td>
              <td className="text-center"><span className={`text-[11px] rounded px-2 py-0.5 ${statusTone(j.status)}`}>{j.status}</span></td>
              <td className="text-center text-xs text-muted-foreground">{new Date(j.created_at).toLocaleString()}</td>
              <td className="text-right space-x-2 pr-2 whitespace-nowrap">
                <button className="underline" disabled={!!busy} onClick={() => void run("translate", j)}>Re-translate</button>
                <button className="underline" disabled={!!busy || !j.migration_sql} onClick={() => void run("dry", j)}>Dry-run</button>
                <button className="underline text-destructive inline-flex items-center gap-1" disabled={!!busy || !j.migration_sql} onClick={() => void run("apply", j)}>
                  <Play className="h-3 w-3" /> Apply
                </button>
                <button className="underline" disabled={!j.migration_sql} onClick={() => setOpenSql(j.migration_sql)}>SQL</button>
              </td>
            </tr>
          ))}
          {!jobs.length && (
            <tr><td colSpan={5} className="px-2 py-4 text-center text-xs text-muted-foreground">No imports yet — install the extension and send one.</td></tr>
          )}
        </tbody>
      </table>

      {openSql && (
        <div className="border rounded p-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium">Translated migration</span>
            <button className="text-xs underline" onClick={() => setOpenSql(null)}>Close</button>
          </div>
          <pre className="text-[11px] font-mono max-h-72 overflow-auto whitespace-pre-wrap">{openSql}</pre>
        </div>
      )}
    </section>
  );
}
