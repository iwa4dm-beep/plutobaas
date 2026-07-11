// Lightweight in-browser simulator for dry-run → apply → rollback → cancel flow.
// Models schema state from parsed SQL without spinning up a real DB, so users
// can iterate the entire safety flow (including induced failures and
// user-initiated cancellations during snapshot / SQL phases) fast.
import type { SqlStatement } from "./types";

export type StepResult = {
  index: number;
  sql: string;
  status: "ok" | "skipped" | "failed" | "cancelled";
  message?: string;
};

export type E2EMode = "dry-run" | "apply" | "induced-fail" | "cancel-snapshot" | "cancel-sql";

export type E2EReport = {
  mode: E2EMode;
  steps: StepResult[];
  finalTables: string[];
  rolledBack: boolean;
  cancelled: boolean;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  jsonl: string; // shaped like apply.sh output so audit report can consume it
};

type Sim = { tables: Set<string> };

function applyToSim(sim: Sim, s: SqlStatement): StepResult {
  if (s.kind === "create_table" && s.table) {
    if (sim.tables.has(s.table)) return { index: -1, sql: s.sql, status: "failed", message: `relation "${s.table}" already exists` };
    sim.tables.add(s.table);
  } else if (s.kind === "drop" && s.table) {
    if (!sim.tables.has(s.table)) return { index: -1, sql: s.sql, status: "failed", message: `relation "${s.table}" does not exist` };
    sim.tables.delete(s.table);
  } else if ((s.kind === "alter" || s.kind === "rls" || s.kind === "grant" || s.kind === "policy") && s.table) {
    if (!sim.tables.has(s.table)) return { index: -1, sql: s.sql, status: "failed", message: `relation "${s.table}" does not exist` };
  }
  return { index: -1, sql: s.sql, status: "ok" };
}

const nowIso = () => new Date().toISOString();

export function runE2E(
  stmts: SqlStatement[],
  opts: { mode: E2EMode; failAt?: number; cancelAt?: number } = { mode: "dry-run" },
): E2EReport {
  const t0 = performance.now();
  const jobId = `sim-${Date.now()}`;
  const sim: Sim = { tables: new Set() };
  const snap = new Set(sim.tables);
  const steps: StepResult[] = [];
  const journal: object[] = [];
  const j = (o: object) => journal.push({ ts: nowIso(), jobId, ...o });
  let rolledBack = false;
  let cancelled = false;

  j({ step: "start", status: "start" });

  // Snapshot phase — user may cancel here in "cancel-snapshot" mode.
  const snapshotSteps = ["snapshot_db", "snapshot_volumes", "snapshot_configs"];
  for (let i = 0; i < snapshotSteps.length; i++) {
    if (opts.mode === "cancel-snapshot" && (opts.cancelAt ?? 1) === i) {
      j({ step: "cancel", status: "start", reason: `cancel during ${snapshotSteps[i]}` });
      cancelled = true;
      // No apply happened → nothing to roll back beyond removing partial snapshot.
      j({ step: "rollback", status: "done", reason: "no db mutations yet" });
      j({ step: "cancel", status: "done", exitCode: 4 });
      const jsonl = journal.map((x) => JSON.stringify(x)).join("\n") + "\n";
      return {
        mode: opts.mode, steps, finalTables: Array.from(sim.tables),
        rolledBack: true, cancelled: true, exitCode: 4, passed: true,
        durationMs: Math.round(performance.now() - t0), jsonl,
      };
    }
    j({ step: snapshotSteps[i], status: "ok" });
  }

  // SQL apply phase.
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];

    if (opts.mode === "cancel-sql" && (opts.cancelAt ?? 0) === i) {
      j({ step: "cancel", status: "start", reason: `cancel at sql #${i}` });
      // Rollback: restore snapshot.
      sim.tables = new Set(snap);
      cancelled = true; rolledBack = true;
      j({ step: "rollback_db", status: "ok" });
      j({ step: "rollback", status: "done" });
      j({ step: "cancel", status: "done", exitCode: 4 });
      break;
    }

    if (opts.mode === "induced-fail" && opts.failAt === i) {
      steps.push({ index: i, sql: s.sql, status: "failed", message: "induced failure" });
      j({ step: `apply_sql`, status: "fail", error: "induced failure", file: `#${i}` });
      sim.tables = new Set(snap); rolledBack = true;
      j({ step: "rollback_db", status: "ok" });
      j({ step: "rollback", status: "done", exitCode: 1 });
      break;
    }

    const r = applyToSim(sim, s); r.index = i;
    steps.push(r);
    j({ step: "apply_sql", status: r.status === "ok" ? "ok" : "fail", file: `#${i}`, error: r.message });
    if (r.status === "failed") {
      sim.tables = new Set(snap); rolledBack = true;
      j({ step: "rollback_db", status: "ok" });
      j({ step: "rollback", status: "done", exitCode: 1 });
      break;
    }
  }

  if (!rolledBack && !cancelled) j({ step: "done", status: "ok", exitCode: 0 });

  const exitCode = cancelled ? 4 : rolledBack ? 1 : 0;
  const passed = opts.mode === "induced-fail"
    ? rolledBack && steps.some((s) => s.status === "failed")
    : opts.mode === "cancel-snapshot" || opts.mode === "cancel-sql"
    ? cancelled && exitCode === 4
    : steps.every((s) => s.status !== "failed");

  const jsonl = journal.map((x) => JSON.stringify(x)).join("\n") + "\n";
  return {
    mode: opts.mode, steps, finalTables: Array.from(sim.tables),
    rolledBack, cancelled, exitCode, passed,
    durationMs: Math.round(performance.now() - t0), jsonl,
  };
}
