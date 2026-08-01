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
  opts: RunOptions = {},
): Promise<GoLiveReport> {
  const started = Date.now();
  const events: RunEvent[] = [];
  const outcomes: StageOutcome[] = [];
  const previous = opts.previous ?? {};

  const emit = (stage: string, level: RunEvent["level"], message: string) => {
    const e: RunEvent = { at: new Date().toISOString(), stage, level, message };
    events.push(e);
    cb.onEvent?.(e);
  };

  emit(
    "run",
    "info",
    `${opts.resume ? "Resume run" : "Auto-run"} started — ${stages.length} stages against ${cfg.apiBase}`,
  );

  for (const s of stages) {
    if (cb.shouldStop?.()) {
      emit("run", "warn", "Stopped by operator — remaining stages skipped.");
      break;
    }

    const prior = previous[s.id];
    if (opts.resume && prior && prior.status === "pass") {
      const carried: StageOutcome = {
        ...prior,
        logs: [...(prior.logs ?? []), "Carried over from the previous run (already passing)."],
      };
      outcomes.push(carried);
      cb.onStage?.(carried);
      emit(s.id, "ok", `Step ${s.n} skipped — already passed in the previous run.`);
      continue;
    }

    const t0 = Date.now();
    const logs: string[] = [];
    const log = (level: RunEvent["level"], message: string) => {
      logs.push(`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`);
      emit(s.id, level, message);
    };

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
    log("info", `Step ${s.n}: ${s.title}`);

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
        logs,
      };
      log("warn", `Manual step — open ${s.page}`);
    } else {
      let attempts = 0;
      let res = await runCheck(s.check, cfg);
      attempts += 1;
      if (res.evidence) {
        log(
          "info",
          `Attempt 1 → ${res.evidence.method} ${res.evidence.url} · HTTP ${res.evidence.status} · ${res.evidence.latencyMs}ms`,
        );
      }

      if (res.status === "fail") {
        log("warn", `Attempt 1 failed: ${res.detail} — retrying in ${RETRY_DELAY_MS}ms`);
        await sleep(RETRY_DELAY_MS);
        res = await runCheck(s.check, cfg);
        attempts += 1;
        if (res.evidence) {
          log(
            "info",
            `Attempt 2 → ${res.evidence.method} ${res.evidence.url} · HTTP ${res.evidence.status} · ${res.evidence.latencyMs}ms`,
          );
        }
      }

      const status = statusFromCheck(res);
      if (res.evidence?.bodyPreview) {
        logs.push(`response: ${res.evidence.bodyPreview}`);
      }
      if (res.evidence?.error) {
        logs.push(`network error: ${res.evidence.error}`);
      }
      for (const h of res.hints ?? []) {
        logs.push(`remediation: ${h.cause} → ${h.fix}${h.link ? ` (${h.link})` : ""}`);
      }

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
        evidence: res.evidence,
        logs,
      };
      log(
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
    skipped: outcomes.filter((o) => o.status === "skipped").length,
  };
  const verdict: GoLiveReport["verdict"] =
    totals.fail > 0 ? "red" : totals.warn > 0 ? "amber" : "green";

  const firstFail = outcomes.find((o) => o.status === "fail");
  const notPassed = outcomes.find((o) => o.status !== "pass");
  const ranAll = outcomes.length === stages.length;
  const resumeFrom = firstFail?.id ?? (ranAll ? (notPassed?.id ?? null) : (stages[outcomes.length]?.id ?? null));

  const finished = Date.now();
  emit(
    "run",
    verdict === "green" ? "ok" : verdict === "amber" ? "warn" : "error",
    `Run finished — ${totals.pass} pass · ${totals.warn} warn · ${totals.fail} fail · ${totals.manual} manual` +
      (firstFail ? ` · first failure at step ${firstFail.n}` : ""),
  );

  return {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    apiBase: cfg.apiBase,
    appOrigin: cfg.appOrigin,
    totals,
    verdict,
    failedStep: firstFail?.n ?? null,
    resumeFrom,
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
    `- First failed step: ${r.failedStep ?? "none"}`,
    `- Resume from: ${r.resumeFrom ?? "nothing pending"}`,
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
    `## Step details`,
    ``,
  ];

  for (const s of r.stages) {
    lines.push(`### Step ${s.n} — ${s.title} (${s.status})`, ``, `${s.detail}`, ``);
    if (s.evidence) {
      lines.push(
        `**Request/response**`,
        ``,
        "```http",
        `${s.evidence.method} ${s.evidence.url}`,
        `→ HTTP ${s.evidence.status} · ${s.evidence.latencyMs}ms`,
        s.evidence.error ? `error: ${s.evidence.error}` : "",
        s.evidence.bodyPreview ? `\n${s.evidence.bodyPreview}` : "",
        "```",
        ``,
      );
    }
    if (s.hints?.length) {
      lines.push(`**Remediation**`, ``);
      for (const h of s.hints) {
        lines.push(`- ${h.cause}`, `  - Fix: ${h.fix}${h.link ? ` → ${h.link}` : ""}`);
      }
      lines.push(``);
    }
    if (s.logs?.length) {
      lines.push(`**Logs**`, ``, "```", ...s.logs, "```", ``);
    }
  }

  lines.push(`## Timeline`, ``, ...r.events.map((e) => `- \`${e.at}\` [${e.level}] **${e.stage}** — ${e.message}`), ``);
  return lines.join("\n");
}

