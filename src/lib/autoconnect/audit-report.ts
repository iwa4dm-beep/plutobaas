// Build a single JSON + HTML audit report combining every safety signal
// (impact, typed-ack, ZIP verification, rollback outcome) so it can be
// downloaded and archived / attached to change requests.
import JSZip from "jszip";
import type { SqlImpact } from "./sql-analyzer";
import type { VerifyResult } from "./zip-verify";
import type { LogSummary } from "./rollback-log";
import type { DbConfig, IntegrationPlan } from "./types";

export type CancellationRecord = {
  at: string;
  jobId?: string;
  via: "ui" | "cli";
  note?: string;
  exitCode?: number;
  phase?: "snapshot" | "sql" | "unknown";
  refusedBecauseFinished?: boolean;
};

export type AuditInput = {
  generatedAt?: string;
  project?: { file?: string; sizeBytes?: number };
  db?: DbConfig;
  plan?: IntegrationPlan | null;
  impact?: SqlImpact | null;
  ack?: { checkbox: boolean; typed: string; required: boolean };
  verification?: VerifyResult | null;
  rollback?: LogSummary | null;
  retentionDays?: number;
  snapshotRoot?: string;
  cancellation?: CancellationRecord | null;
  rawLogJsonl?: string | null;
};

export type AuditReport = {
  generatedAt: string;
  summary: {
    verified: boolean;
    ackOk: boolean;
    destructive: number;
    tables: number;
    rollbackStatus: "n/a" | "ok" | "rolled_back" | "failed" | "cancelled";
    exitCode: number | null;
    cancelRefused: boolean;
  };
  input: AuditInput;
};

export function buildAuditJson(input: AuditInput): AuditReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const verified = !input.verification?.hasManifest ? true : input.verification.ok;
  const ackOk = !input.ack?.required
    ? true
    : (input.ack.checkbox && input.ack.typed.trim().toUpperCase() === "APPLY");
  const rollbackStatus: AuditReport["summary"]["rollbackStatus"] = input.cancellation
    ? "cancelled"
    : !input.rollback
    ? "n/a"
    : input.rollback.ok ? "ok"
    : input.rollback.rolledBack ? "rolled_back" : "failed";
  const exitCode =
    input.cancellation?.exitCode ??
    input.rollback?.exitCode ??
    (rollbackStatus === "cancelled" ? 4
      : rollbackStatus === "ok" ? 0
      : rollbackStatus === "rolled_back" ? 1
      : rollbackStatus === "failed" ? 2
      : null);
  const cancelRefused = !!input.cancellation?.refusedBecauseFinished;
  return {
    generatedAt,
    summary: {
      verified,
      ackOk,
      destructive: input.impact?.destructive ?? 0,
      tables: input.impact?.affectedTables.length ?? 0,
      rollbackStatus,
      exitCode,
      cancelRefused,
    },
    input,
  };
}

// Build a single downloadable ZIP that contains the JSON + HTML audit report,
// the raw JSONL progress log, and a verification-mismatch CSV so an operator
// has one artifact to attach to a change-request / incident ticket.
export async function buildAuditBundle(input: AuditInput): Promise<Blob> {
  const report = buildAuditJson(input);
  const html = buildAuditHtml(report);
  const zip = new JSZip();
  const jobId = input.rollback?.jobId || input.cancellation?.jobId || "audit";
  const stamp = (input.generatedAt ?? report.generatedAt).replace(/[:.]/g, "-");
  const dir = `audit-${jobId}-${stamp}`;
  zip.folder(dir)!.file("audit-report.json", JSON.stringify(report, null, 2));
  zip.folder(dir)!.file("audit-report.html", html);
  if (input.rawLogJsonl) zip.folder(dir)!.file(`${jobId}.jsonl`, input.rawLogJsonl);
  if (input.verification?.entries?.length) {
    const rows = ["path,ok,expected,actual,note"];
    for (const e of input.verification.entries) {
      rows.push([e.path, e.ok ? "1" : "0", e.expected, e.actual, e.ok ? "" : (e.actual ? "hash-mismatch" : "missing")].join(","));
    }
    zip.folder(dir)!.file("verification-mismatches.csv", rows.join("\n") + "\n");
  }
  if (input.cancellation) {
    zip.folder(dir)!.file("cancellation.json", JSON.stringify(input.cancellation, null, 2));
  }
  zip.folder(dir)!.file("README.txt",
    `Audit bundle for job ${jobId}\nGenerated: ${report.generatedAt}\nExit code: ${report.summary.exitCode ?? "n/a"}\nRollback: ${report.summary.rollbackStatus}\n`);
  return await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildAuditHtml(report: AuditReport): string {
  const { summary, input, generatedAt } = report;
  const badge = (ok: boolean, ok_l: string, bad_l: string) =>
    `<span class="badge ${ok ? "ok" : "bad"}">${ok ? ok_l : bad_l}</span>`;

  const verifyRows = (input.verification?.entries ?? [])
    .slice(0, 200)
    .map((e) => `<tr><td>${e.ok ? "✓" : "✘"}</td><td><code>${escapeHtml(e.path)}</code></td>
      <td class="mono small">${escapeHtml(e.expected.slice(0, 12))}…</td>
      <td class="mono small">${escapeHtml(e.actual.slice(0, 12))}…</td></tr>`)
    .join("");

  const impactRows = input.impact ? `
    <tr><th>Total statements</th><td>${input.impact.total}</td></tr>
    <tr><th>New tables</th><td>${input.impact.newTables}</td></tr>
    <tr><th>Destructive</th><td>${input.impact.destructive}</td></tr>
    <tr><th>Columns +/−</th><td>${input.impact.columnsAdded} / ${input.impact.columnsDropped}</td></tr>
    <tr><th>Indexes / FKs</th><td>${input.impact.indexes} / ${input.impact.fkAdded}</td></tr>
    <tr><th>RLS / policies / grants</th><td>${input.impact.rlsEnabled} / ${input.impact.policies} / ${input.impact.grants}</td></tr>
    <tr><th>Roles touched</th><td>${escapeHtml(input.impact.rolesTouched.join(", ") || "—")}</td></tr>
    <tr><th>Tables touched</th><td>${escapeHtml(input.impact.affectedTables.join(", ") || "—")}</td></tr>
    <tr><th>Row-impact estimate</th><td>${input.impact.rowsEstimate}</td></tr>` : "";

  const destructiveList = (input.impact?.destructiveStatements ?? [])
    .map((d) => `<li>#${d.index} <b>${d.kind}</b>${d.table ? ` on <code>${escapeHtml(d.table)}</code>` : ""} — <span class="mono small">${escapeHtml(d.sample)}</span></li>`)
    .join("");

  const rollback = input.rollback;
  const rollbackRows = rollback
    ? rollback.entries.map((e) => `<tr>
        <td class="mono small">${escapeHtml(e.ts)}</td>
        <td><span class="badge ${e.status === "fail" ? "bad" : e.status === "ok" || e.status === "done" ? "ok" : "muted"}">${e.status}</span></td>
        <td>${escapeHtml(e.step)}</td>
        <td class="mono small">${escapeHtml(e.error ?? e.file ?? e.volume ?? "")}</td>
      </tr>`).join("")
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Auto-Connect Audit — ${escapeHtml(generatedAt)}</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:2rem;max-width:1000px;margin:auto;background:#0b0d10;color:#e6e8eb}
h1,h2{color:#fff;margin-top:1.5rem}
h1{border-bottom:1px solid #2a2f36;padding-bottom:.5rem}
table{width:100%;border-collapse:collapse;margin:.5rem 0}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #23272d;vertical-align:top}
th{color:#9aa4af;font-weight:600}
code,.mono{font-family:ui-monospace,Menlo,monospace}
.small{font-size:12px;color:#9aa4af}
.badge{display:inline-block;padding:.15rem .5rem;border-radius:999px;font-size:12px;font-weight:600}
.badge.ok{background:#14532d;color:#bbf7d0}
.badge.bad{background:#7f1d1d;color:#fecaca}
.badge.muted{background:#23272d;color:#9aa4af}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;margin:.5rem 0}
.card{background:#141821;border:1px solid #23272d;border-radius:8px;padding:.75rem 1rem}
.card b{display:block;font-size:22px;color:#fff}
.card small{color:#9aa4af}
</style></head>
<body>
<h1>Auto-Connect Studio — Audit Report</h1>
<p class="small">Generated: <code>${escapeHtml(generatedAt)}</code>
${input.project?.file ? ` · Source: <code>${escapeHtml(input.project.file)}</code>` : ""}
${input.db ? ` · DB: <code>${escapeHtml(input.db.driver)}://${escapeHtml(input.db.host ?? "?")}:${input.db.port ?? "?"}/${escapeHtml(input.db.database ?? "?")}</code>` : ""}
${input.retentionDays != null ? ` · Retention: <b>${input.retentionDays}d</b>` : ""}
${input.snapshotRoot ? ` · Snapshot root: <code>${escapeHtml(input.snapshotRoot)}</code>` : ""}</p>

${input.cancellation ? `<div class="card" style="border-color:${input.cancellation.refusedBecauseFinished ? "#a16207" : "#7f1d1d"}">
<small>Cancellation ${input.cancellation.refusedBecauseFinished ? "REFUSED (job already finished)" : "recorded"}</small>
<b>${badge(!!input.cancellation.refusedBecauseFinished, "refused", "cancelled")}</b>
<div class="small">At <code>${escapeHtml(input.cancellation.at)}</code>
${input.cancellation.jobId ? ` · job <code>${escapeHtml(input.cancellation.jobId)}</code>` : ""}
${input.cancellation.phase ? ` · phase <b>${escapeHtml(input.cancellation.phase)}</b>` : ""}
${input.cancellation.exitCode != null ? ` · exit code <b>${input.cancellation.exitCode}</b>` : ""}
· via ${input.cancellation.via}${input.cancellation.note ? ` — ${escapeHtml(input.cancellation.note)}` : ""}
${input.cancellation.refusedBecauseFinished ? `<br><i>Job had already terminated — no cancel signal was sent. See rollback status below.</i>` : ""}
</div></div>` : ""}

<div class="grid">
  <div class="card"><small>ZIP integrity</small><b>${badge(summary.verified, "verified", "failed")}</b></div>
  <div class="card"><small>Destructive ack</small><b>${badge(summary.ackOk, "ok", "missing")}</b></div>
  <div class="card"><small>Destructive stmts</small><b>${summary.destructive}</b></div>
  <div class="card"><small>Tables touched</small><b>${summary.tables}</b></div>
  <div class="card"><small>Rollback</small><b>${badge(summary.rollbackStatus === "ok", summary.rollbackStatus, summary.rollbackStatus)}</b></div>
  <div class="card"><small>Exit code</small><b>${summary.exitCode ?? "n/a"}</b></div>
</div>

<h2>1. ZIP / Manifest Verification</h2>
${input.verification ? `
<p>${escapeHtml(input.verification.message)}</p>
${input.verification.entries.length ? `<table><thead><tr><th></th><th>Path</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${verifyRows}</tbody></table>` : "<p class='small'>No manifest to check.</p>"}
` : "<p class='small'>Not run.</p>"}

<h2>2. Impact Summary</h2>
${input.impact ? `<table>${impactRows}</table>
${destructiveList ? `<h3>Destructive statements</h3><ul>${destructiveList}</ul>` : ""}` : "<p class='small'>No impact analysis available.</p>"}

<h2>3. Acknowledgement</h2>
${input.ack ? `<table>
  <tr><th>Required</th><td>${input.ack.required ? "yes (destructive stmts present)" : "no"}</td></tr>
  <tr><th>Checkbox</th><td>${badge(input.ack.checkbox, "checked", "unchecked")}</td></tr>
  <tr><th>Typed confirmation</th><td><code>${escapeHtml(input.ack.typed || "(empty)")}</code> ${badge(input.ack.typed.trim().toUpperCase() === "APPLY", "APPLY", "not APPLY")}</td></tr>
</table>` : "<p class='small'>—</p>"}

<h2>4. Rollback / Apply Log</h2>
${rollback ? `<p>Job <code>${escapeHtml(rollback.jobId)}</code> — status: ${badge(rollback.ok, "ok", rollback.rolledBack ? "rolled_back" : "failed")}
${rollback.failedStep ? ` — failed step: <b>${escapeHtml(rollback.failedStep.step)}</b>` : ""}</p>
<table><thead><tr><th>ts</th><th>status</th><th>step</th><th>detail</th></tr></thead><tbody>${rollbackRows}</tbody></table>`
: "<p class='small'>No rollback log attached — run apply.sh on the VPS and upload the JSONL to attach here.</p>"}

<hr>
<p class="small">Auto-Connect Studio · self-contained HTML audit — safe to archive alongside the migration bundle.</p>
</body></html>`;
}
