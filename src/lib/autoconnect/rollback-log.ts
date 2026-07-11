// Parse JSONL rollback logs produced by apply.sh into a step timeline.
export type LogEntry = {
  ts: string;
  jobId?: string;
  step: string;
  status: "start" | "ok" | "fail" | "skip" | "done";
  error?: string;
  file?: string;
  volume?: string;
  snapDir?: string;
  reason?: string;
  exitCode?: number;
};

export type LogSummary = {
  jobId: string;
  entries: LogEntry[];
  ok: boolean;
  failedStep?: LogEntry;
  rolledBack: boolean;
  cancelled: boolean;
  finished: boolean;
  exitCode: number | null;
  startedAt?: string;
  endedAt?: string;
};

export function parseRollbackLog(text: string): LogSummary {
  const entries: LogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { entries.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  const failed = entries.find((e) => e.status === "fail" && e.step.startsWith("apply"));
  const rolledBack = entries.some((e) => e.step === "rollback" && e.status === "done");
  const cancelled = entries.some((e) => e.step === "cancel");
  const ok = entries.some((e) => e.step === "done" && e.status === "ok");
  // A job is "finished" once we've observed a terminal record.
  const finished = ok || rolledBack || cancelled || !!failed
    || entries.some((e) => e.status === "done" || (e.status === "fail" && !!e.exitCode));
  // Prefer explicit exitCode; else derive from terminal signals.
  const explicit = [...entries].reverse().find((e) => typeof e.exitCode === "number");
  const exitCode: number | null = explicit?.exitCode ??
    (cancelled ? 4 : ok ? 0 : rolledBack ? 1 : failed ? 2 : null);
  return {
    jobId: entries[0]?.jobId ?? "unknown",
    entries,
    ok,
    failedStep: failed,
    rolledBack,
    cancelled,
    finished,
    exitCode,
    startedAt: entries[0]?.ts,
    endedAt: entries[entries.length - 1]?.ts,
  };
}
