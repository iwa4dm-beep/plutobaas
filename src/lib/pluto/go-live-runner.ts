/**
 * Go-Live auto-runner: executes the 10-step connect roadmap end-to-end.
 *
 * Pure browser logic. Check-backed stages call the existing connect-wizard
 * probes; a failing probe is retried once after a short settle delay (most
 * failures right after CORS/import changes are propagation, not config).
 * Stages without a probe are reported as "manual" with the page to open.
 */

import {
  runCheck,
  type CheckId,
  type CheckResult,
  type Evidence,
  type WizardConfig,
} from "./connect-wizard";

export type StageStatus =
  | "idle"
  | "running"
  | "pass"
  | "warn"
  | "fail"
  | "manual"
  | "skipped";

export type StageSpec = {
  id: string;
  n: number;
  title: string;
  title_bn: string;
  check?: CheckId;
  /** Page the operator should open when this stage needs hands-on work. */
  page: string;
};

export type StageOutcome = {
  id: string;
  n: number;
  title: string;
  status: StageStatus;
  detail: string;
  attempts: number;
  durationMs: number;
  page: string;
  hints?: CheckResult["hints"];
  /** Request/response snippet from the last probe attempt. */
  evidence?: Evidence;
  /** Per-stage log lines, mirrored into the exported report. */
  logs?: string[];
};

export type RunEvent = {
  at: string;
  stage: string;
  level: "info" | "ok" | "warn" | "error";
  message: string;
};

export type GoLiveReport = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  apiBase: string;
  appOrigin: string;
  totals: { total: number; pass: number; warn: number; fail: number; manual: number; skipped: number };
  verdict: "green" | "amber" | "red";
  /** First failing step number, for alerting and resume. */
  failedStep: number | null;
  /** Step id the next resume run should start from (null = nothing pending). */
  resumeFrom: string | null;
  stages: StageOutcome[];
  events: RunEvent[];
};

export type RunnerCallbacks = {
  onStage?: (o: StageOutcome) => void;
  onEvent?: (e: RunEvent) => void;
  /** Return true to abort the remaining stages. */
  shouldStop?: () => boolean;
};

export type RunOptions = {
  /** Outcomes carried over from a previous run; passed stages are reused, not re-probed. */
  previous?: Record<string, StageOutcome>;
  /** Resume mode: skip stages that already passed in `previous`. */
  resume?: boolean;
};


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry delay before the second attempt of a failing probe. */
export const RETRY_DELAY_MS = 1500;

function statusFromCheck(r: CheckResult): StageStatus {
  if (r.status === "pass") return "pass";
  if (r.status === "warn") return "warn";
  if (r.status === "skipped") return "manual";
  return "fail";
}

export async function runGoLive(
  stages: StageSpec[],
  cfg: WizardConfig,
  cb: RunnerCallbacks = {},
): Promise<GoLiveReport> {
  const started = Date.now();
  const events: RunEvent[] = [];
  const outcomes: StageOutcome[] = [];

  const emit = (stage: string, level: RunEvent["level"], message: string) => {
    const e: RunEvent = { at: new Date().toISOString(), stage, level, message };
    events.push(e);
    cb.onEvent?.(e);
  };

  emit("run", "info", `Auto-run started — ${stages.length} stages against ${cfg.apiBase}`);

  for (const s of stages) {
    if (cb.shouldStop?.()) {
      emit("run", "warn", "Stopped by operator — remaining stages skipped.");
      break;
    }

    const t0 = Date.now();
    cb.onStage?.({
      id: s.id,
      n: s.n,
      title: s.title,
      status: "running",
      detail: "Running…",
      attempts: 0,
      durationMs: 0,
      page: s.page,
    });
    emit(s.id, "info", `Step ${s.n}: ${s.title}`);

    let outcome: StageOutcome;

    if (!s.check) {
      outcome = {
        id: s.id,
        n: s.n,
        title: s.title,
        status: "manual",
        detail: "No automated probe for this step — open the page and confirm manually.",
        attempts: 0,
        durationMs: Date.now() - t0,
        page: s.page,
      };
      emit(s.id, "warn", `Manual step — open ${s.page}`);
    } else {
      let attempts = 0;
      let res = await runCheck(s.check, cfg);
      attempts += 1;

      if (res.status === "fail") {
        emit(s.id, "warn", `Attempt 1 failed: ${res.detail} — retrying in ${RETRY_DELAY_MS}ms`);
        await sleep(RETRY_DELAY_MS);
        res = await runCheck(s.check, cfg);
        attempts += 1;
      }

      const status = statusFromCheck(res);
      outcome = {
        id: s.id,
        n: s.n,
        title: s.title,
        status,
        detail: res.detail,
        attempts,
        durationMs: Date.now() - t0,
        page: s.page,
        hints: res.hints,
      };
      emit(
        s.id,
        status === "pass" ? "ok" : status === "fail" ? "error" : "warn",
        `${status.toUpperCase()} — ${res.detail}`,
      );
    }

    outcomes.push(outcome);
    cb.onStage?.(outcome);
  }

  const totals = {
    total: outcomes.length,
    pass: outcomes.filter((o) => o.status === "pass").length,
    warn: outcomes.filter((o) => o.status === "warn").length,
    fail: outcomes.filter((o) => o.status === "fail").length,
    manual: outcomes.filter((o) => o.status === "manual").length,
  };
  const verdict: GoLiveReport["verdict"] =
    totals.fail > 0 ? "red" : totals.warn > 0 ? "amber" : "green";

  const finished = Date.now();
  emit(
    "run",
    verdict === "green" ? "ok" : verdict === "amber" ? "warn" : "error",
    `Auto-run finished — ${totals.pass} pass · ${totals.warn} warn · ${totals.fail} fail · ${totals.manual} manual`,
  );

  return {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    apiBase: cfg.apiBase,
    appOrigin: cfg.appOrigin,
    totals,
    verdict,
    stages: outcomes,
    events,
  };
}

export function goLiveReportToMarkdown(r: GoLiveReport): string {
  const lines = [
    `# Pluto Go-Live Auto-Run Report`,
    ``,
    `- Verdict: **${r.verdict.toUpperCase()}**`,
    `- API base: ${r.apiBase}`,
    `- App origin: ${r.appOrigin}`,
    `- Started: ${r.startedAt}`,
    `- Duration: ${(r.durationMs / 1000).toFixed(1)}s`,
    `- Totals: ${r.totals.pass} pass / ${r.totals.warn} warn / ${r.totals.fail} fail / ${r.totals.manual} manual`,
    ``,
    `## Stages`,
    ``,
    `| # | Stage | Status | Attempts | Detail | Page |`,
    `| - | ----- | ------ | -------- | ------ | ---- |`,
    ...r.stages.map(
      (s) =>
        `| ${s.n} | ${s.title} | ${s.status} | ${s.attempts} | ${s.detail.replace(/\|/g, "\\|")} | ${s.page} |`,
    ),
    ``,
    `## Timeline`,
    ``,
    ...r.events.map((e) => `- \`${e.at}\` [${e.level}] **${e.stage}** — ${e.message}`),
    ``,
  ];
  return lines.join("\n");
}
