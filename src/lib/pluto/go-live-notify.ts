/**
 * Go-live run notifications.
 *
 * Fires a single JSON payload at an operator-supplied webhook URL when an
 * auto-run finishes (success or failure), including the first failed step
 * number so alert routing can page on it. If an email address is configured
 * it travels inside the payload as `email` so the receiving automation
 * (Zapier / n8n / your own handler) can forward it — the browser cannot send
 * mail itself.
 */

import type { GoLiveReport } from "./go-live-runner";

export type NotifyConfig = {
  webhookUrl: string;
  email: string;
  /** Alert only when the run fails. */
  onFailureOnly: boolean;
};

export const NOTIFY_KEY = "pluto.goLive.notify";

export const EMPTY_NOTIFY: NotifyConfig = { webhookUrl: "", email: "", onFailureOnly: false };

export function loadNotifyConfig(): NotifyConfig {
  try {
    const raw = localStorage.getItem(NOTIFY_KEY);
    if (raw) return { ...EMPTY_NOTIFY, ...(JSON.parse(raw) as Partial<NotifyConfig>) };
  } catch {
    /* ignore */
  }
  return EMPTY_NOTIFY;
}

export function saveNotifyConfig(cfg: NotifyConfig): void {
  try {
    localStorage.setItem(NOTIFY_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

export type NotifyOutcome = {
  attempted: boolean;
  ok: boolean;
  detail: string;
};

export function buildNotifyPayload(report: GoLiveReport, cfg: NotifyConfig) {
  const failed = report.stages.filter((s) => s.status === "fail");
  const first = failed[0];
  return {
    event: report.verdict === "red" ? "go_live.failed" : "go_live.completed",
    verdict: report.verdict,
    apiBase: report.apiBase,
    appOrigin: report.appOrigin,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    durationMs: report.durationMs,
    totals: report.totals,
    failedStep: first ? first.n : null,
    failedStepTitle: first ? first.title : null,
    failedSteps: failed.map((s) => ({ n: s.n, id: s.id, title: s.title, detail: s.detail })),
    email: cfg.email || undefined,
    summary:
      report.verdict === "green"
        ? `Go-live run passed ${report.totals.pass}/${report.totals.total} steps.`
        : `Go-live run ${report.verdict.toUpperCase()} — ${report.totals.fail} failed` +
          (first ? `, first failure at step ${first.n}: ${first.title}` : ""),
  };
}

export async function notifyGoLive(
  report: GoLiveReport,
  cfg: NotifyConfig,
): Promise<NotifyOutcome> {
  if (!cfg.webhookUrl.trim()) {
    return { attempted: false, ok: false, detail: "No notification webhook configured." };
  }
  if (cfg.onFailureOnly && report.verdict === "green") {
    return { attempted: false, ok: true, detail: "Run passed — failure-only alerting skipped." };
  }
  const payload = buildNotifyPayload(report, cfg);
  try {
    const res = await fetch(cfg.webhookUrl.trim(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return {
      attempted: true,
      ok: res.ok,
      detail: res.ok ? `Notification delivered (HTTP ${res.status}).` : `Webhook returned HTTP ${res.status}.`,
    };
  } catch (e) {
    return {
      attempted: true,
      ok: false,
      detail: `Notification failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
