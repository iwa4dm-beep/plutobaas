// Shared helpers for the Connect-Project tools:
//   - retryWithBackoff: exponential-backoff retry wrapper
//   - downloadReport:   JSON / HTML report exporter
//
// These are intentionally UI-agnostic so both the RealtimeVerifier
// and the E2ETestRunner can share behaviour.

export type RetryConfig = {
  maxRetries: number;     // total attempts = maxRetries + 1
  baseDelayMs: number;    // first back-off in ms
  maxDelayMs?: number;    // cap
};

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<{ ok: boolean; value: T }>,
  cfg: RetryConfig,
  onAttempt?: (attempt: number, ok: boolean, delayMs: number) => void,
): Promise<{ ok: boolean; value: T; attempts: number }> {
  let last: { ok: boolean; value: T } = { ok: false, value: undefined as unknown as T };
  const cap = cfg.maxDelayMs ?? 8000;
  for (let i = 0; i <= cfg.maxRetries; i++) {
    last = await fn(i);
    if (last.ok) {
      onAttempt?.(i, true, 0);
      return { ...last, attempts: i + 1 };
    }
    if (i === cfg.maxRetries) {
      onAttempt?.(i, false, 0);
      break;
    }
    const delay = Math.min(cap, cfg.baseDelayMs * 2 ** i) + Math.floor(Math.random() * 100);
    onAttempt?.(i, false, delay);
    await new Promise((r) => setTimeout(r, delay));
  }
  return { ...last, attempts: cfg.maxRetries + 1 };
}

/* --------------------------------- report -------------------------------- */

export type ReportStep = {
  key: string;
  label: string;
  status: "idle" | "running" | "ok" | "fail" | "skipped";
  ms?: number;
  detail?: string;
  error?: string;
  attempts?: number;
};

export type Report = {
  tool: string;
  apiBase: string;
  generatedAt: string;
  summary: { total: number; ok: number; failed: number; skipped: number; totalMs: number };
  steps: ReportStep[];
  events?: { at: string; kind: string; message: string }[];
};

export function buildReport(input: Omit<Report, "generatedAt" | "summary">): Report {
  const ok = input.steps.filter((s) => s.status === "ok").length;
  const failed = input.steps.filter((s) => s.status === "fail").length;
  const skipped = input.steps.filter((s) => s.status === "skipped").length;
  const totalMs = input.steps.reduce((n, s) => n + (s.ms ?? 0), 0);
  return {
    ...input,
    generatedAt: new Date().toISOString(),
    summary: { total: input.steps.length, ok, failed, skipped, totalMs },
  };
}

function downloadBlob(name: string, mime: string, content: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadReportJson(report: Report) {
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  downloadBlob(`pluto-${report.tool}-${stamp}.json`, "application/json", JSON.stringify(report, null, 2));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function downloadReportHtml(report: Report) {
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const badge = (s: string) => {
    const color =
      s === "ok" ? "#16a34a" :
      s === "fail" ? "#dc2626" :
      s === "skipped" ? "#6b7280" :
      s === "running" ? "#2563eb" : "#9ca3af";
    return `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;background:${color};color:#fff;font-size:11px;font-weight:600">${s.toUpperCase()}</span>`;
  };
  const rows = report.steps.map((s) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${badge(s.status)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:ui-monospace,Menlo,monospace;font-size:12px">${escapeHtml(s.key)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${escapeHtml(s.label)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;color:#6b7280">${s.ms ?? ""}${s.ms != null ? " ms" : ""}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center;color:#6b7280">${s.attempts ?? 1}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#374151;white-space:pre-wrap;word-break:break-all">${escapeHtml(s.error ?? s.detail ?? "")}</td>
    </tr>`).join("");
  const events = (report.events ?? []).map((e) => `
    <tr>
      <td style="padding:4px 8px;border-bottom:1px solid #f3f4f6;color:#6b7280;font-family:ui-monospace,Menlo,monospace;font-size:11px">${escapeHtml(e.at)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #f3f4f6;font-weight:600">${escapeHtml(e.kind)}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #f3f4f6;font-family:ui-monospace,Menlo,monospace;font-size:11px">${escapeHtml(e.message)}</td>
    </tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Pluto ${escapeHtml(report.tool)} report</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:960px;margin:40px auto;padding:0 20px;color:#0f172a}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:24px 0 8px;text-transform:uppercase;color:#6b7280;letter-spacing:.05em}table{width:100%;border-collapse:collapse}.stat{display:inline-block;margin-right:16px;font-size:13px;color:#374151}.stat b{color:#0f172a}</style>
</head><body>
<h1>Pluto — ${escapeHtml(report.tool)} report</h1>
<div style="color:#6b7280;font-size:12px">Generated ${escapeHtml(report.generatedAt)} · apiBase <code>${escapeHtml(report.apiBase)}</code></div>
<h2>Summary</h2>
<div><span class="stat">Total: <b>${report.summary.total}</b></span><span class="stat" style="color:#16a34a">OK: <b>${report.summary.ok}</b></span><span class="stat" style="color:#dc2626">Failed: <b>${report.summary.failed}</b></span><span class="stat">Skipped: <b>${report.summary.skipped}</b></span><span class="stat">Total latency: <b>${report.summary.totalMs} ms</b></span></div>
<h2>Steps</h2>
<table><thead><tr><th style="text-align:left;padding:8px;border-bottom:2px solid #0f172a">Status</th><th style="text-align:left;padding:8px;border-bottom:2px solid #0f172a">Key</th><th style="text-align:left;padding:8px;border-bottom:2px solid #0f172a">Label</th><th style="text-align:right;padding:8px;border-bottom:2px solid #0f172a">Latency</th><th style="text-align:center;padding:8px;border-bottom:2px solid #0f172a">Attempts</th><th style="text-align:left;padding:8px;border-bottom:2px solid #0f172a">Detail / error</th></tr></thead><tbody>${rows}</tbody></table>
${events ? `<h2>Events</h2><table><thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:2px solid #0f172a">At</th><th style="text-align:left;padding:4px 8px;border-bottom:2px solid #0f172a">Kind</th><th style="text-align:left;padding:4px 8px;border-bottom:2px solid #0f172a">Message</th></tr></thead><tbody>${events}</tbody></table>` : ""}
</body></html>`;
  downloadBlob(`pluto-${report.tool}-${stamp}.html`, "text/html", html);
}
