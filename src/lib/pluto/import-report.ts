// Client-side export of an import job report: raw JSON download, plus a
// print-ready HTML document the browser saves as PDF (no extra dependency,
// and the layout matches the dashboard's own styling).
import type { ImportReportBundle } from "./import-job.functions";

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fileStem(b: ImportReportBundle): string {
  const label = (b.job.repo ?? b.job.slug ?? b.job.event_id).replace(/[^\w.-]+/g, "-").slice(0, 60);
  return `pluto-import-${label}-${b.job.id.slice(0, 8)}`;
}

export function downloadReportJson(bundle: ImportReportBundle): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileStem(bundle)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function statusColor(s: string): string {
  return s === "fail" ? "#b91c1c" : s === "warn" ? "#b45309" : "#15803d";
}

export function buildReportHtml(b: ImportReportBundle): string {
  const v = b.verification;
  const rows = (arr: string[]) => arr.join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Pluto import report — ${esc(b.job.repo ?? b.job.event_id)}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 12px/1.5 ui-sans-serif, system-ui, sans-serif; color: #111827; margin: 32px; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  h2 { font-size: 13px; margin: 22px 0 6px; border-bottom: 1px solid #e5e7eb; padding-bottom: 3px; }
  .muted { color: #6b7280; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #eee; vertical-align: top; font-size: 11px; }
  th { background: #f9fafb; font-weight: 600; }
  code, pre { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; }
  pre { white-space: pre-wrap; background: #f9fafb; border: 1px solid #eee; padding: 8px; border-radius: 4px; }
  .kv { display: grid; grid-template-columns: 150px 1fr; gap: 2px 10px; margin-top: 6px; }
  .kv div:nth-child(odd) { color: #6b7280; }
  .fail { color: #b91c1c; } .warn { color: #b45309; } .pass { color: #15803d; }
  @page { margin: 16mm; }
</style></head><body>
<h1>Pluto import report</h1>
<div class="muted">Generated ${esc(new Date(b.generatedAt).toLocaleString())}${b.generatedBy ? ` by ${esc(b.generatedBy)}` : ""}</div>

<h2>Job</h2>
<div class="kv">
  <div>Job id</div><div><code>${esc(b.job.id)}</code></div>
  <div>Source</div><div>${esc(b.job.source)}</div>
  <div>Repository / slug</div><div>${esc(b.job.repo ?? b.job.slug ?? "—")}</div>
  <div>Status</div><div>${esc(b.job.status)}${b.job.paused ? " (paused)" : ""}</div>
  <div>Created</div><div>${esc(new Date(b.job.created_at).toLocaleString())}</div>
  <div>Applied</div><div>${b.job.applied_at ? `${esc(new Date(b.job.applied_at).toLocaleString())}${b.job.applied_by ? ` · ${esc(b.job.applied_by)}` : ""}` : "—"}</div>
  <div>Selected objects</div><div>${b.job.selection?.length ? esc(b.job.selection.join(", ")) : "all objects in dump"}</div>
</div>

<h2>Apply diff</h2>
${b.diff
    ? `<div>${b.diff.counts.create} create · ${b.diff.counts.alter} alter · <span class="fail">${b.diff.counts.drop} drop</span> · ${b.diff.counts.insert ?? 0} data · ${b.diff.destructiveCount} destructive statement(s)</div>`
    : `<div class="muted">No migration SQL on this job.</div>`}

<h2>Verification (smoke tests / integrity checks)</h2>
${v
    ? `<div><span class="pass">${v.counts.pass} pass</span> · <span class="warn">${v.counts.warn} warn</span> · <span class="fail">${v.counts.fail} fail</span> — ${v.targets.length} object(s), ${v.durationMs} ms, ${esc(new Date(v.ranAt).toLocaleString())}</div>
<table><thead><tr><th>Check</th><th>Target</th><th>Status</th><th>Detail</th></tr></thead><tbody>
${rows(v.checks.map((c) => `<tr><td>${esc(c.label)}</td><td><code>${esc(c.target)}</code></td><td style="color:${statusColor(c.status)}">${esc(c.status)}</td><td>${esc(c.detail)}</td></tr>`))}
</tbody></table>`
    : `<div class="muted">Not run yet — verification runs automatically after a successful apply.</div>`}

<h2>SQL version archive (${b.versions.length})</h2>
<table><thead><tr><th>#</th><th>Kind</th><th>When</th><th>Actor</th><th>c/a/d</th><th>Note</th></tr></thead><tbody>
${rows(b.versions.map((x) => `<tr><td>v${x.version}</td><td>${esc(x.kind)}</td><td>${esc(new Date(x.created_at).toLocaleString())}</td><td>${esc(x.actor_email ?? "system")}</td><td>${x.counts ? `${x.counts.create ?? 0}/${x.counts.alter ?? 0}/${x.counts.drop ?? 0}` : "—"}</td><td>${esc(x.note ?? "")}</td></tr>`))}
${b.versions.length ? "" : `<tr><td colspan="6" class="muted">No archived versions.</td></tr>`}
</tbody></table>

<h2>Step-wise errors (${b.failures.length})</h2>
${b.failures.length
    ? `<table><thead><tr><th>Step</th><th>When</th><th>Message</th></tr></thead><tbody>
${rows(b.failures.map((f) => `<tr><td class="fail">${esc(f.step)}</td><td>${esc(new Date(f.created_at).toLocaleString())}</td><td>${esc(f.message ?? "")}${f.detail ? `<pre>${esc(f.detail.slice(0, 1200))}</pre>` : ""}</td></tr>`))}
</tbody></table>`
    : `<div class="muted">No failures recorded.</div>`}

<h2>Timeline (${b.events.length} audit events)</h2>
<table><thead><tr><th>When</th><th>Step</th><th>OK</th><th>Actor</th><th>Rows</th><th>Message</th></tr></thead><tbody>
${rows(b.events.map((e) => `<tr><td>${esc(new Date(e.created_at).toLocaleString())}</td><td>${esc(e.step)}</td><td style="color:${e.ok ? "#15803d" : "#b91c1c"}">${e.ok ? "yes" : "no"}</td><td>${esc(e.actor_email ?? "system")}</td><td>${e.row_count ?? "—"}</td><td>${esc(e.message ?? "")}</td></tr>`))}
</tbody></table>

${b.migrationSql ? `<h2>Migration SQL</h2><pre>${esc(b.migrationSql)}</pre>` : ""}
</body></html>`;
}

/** Opens the printable report; the browser's print dialog saves it as PDF. */
export function openReportPdf(bundle: ImportReportBundle): boolean {
  const win = window.open("", "_blank", "noopener,width=1000,height=800");
  if (!win) return false;
  win.document.write(buildReportHtml(bundle));
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
  return true;
}
