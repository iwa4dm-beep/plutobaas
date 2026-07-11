// End-to-end assertion that cancelling during snapshot / SQL phases produces
// exit code 4, rolls back, and is faithfully reflected in audit-report.json.
// Runs in CI (`bunx vitest run src/lib/autoconnect/e2e-cancel.spec.ts`) so
// regressions in the cancel flow break the build.
import { describe, it, expect } from "vitest";
import { runE2E } from "./e2e-runner";
import { buildAuditJson } from "./audit-report";
import { parseRollbackLog } from "./rollback-log";
import type { SqlStatement } from "./types";

const stmts: SqlStatement[] = [
  { sql: "CREATE TABLE users (id int)", kind: "create_table", table: "users", destructive: false },
  { sql: "CREATE TABLE posts (id int)", kind: "create_table", table: "posts", destructive: false },
  { sql: "ALTER TABLE users ADD COLUMN email text", kind: "alter", table: "users", destructive: false },
];

function auditFor(mode: "cancel-snapshot" | "cancel-sql", cancelAt: number) {
  const r = runE2E(stmts, { mode, cancelAt });
  const rollback = parseRollbackLog(r.jsonl);
  const audit = buildAuditJson({
    ack: { checkbox: true, typed: "APPLY", required: true },
    rollback,
    rawLogJsonl: r.jsonl,
    cancellation: {
      at: new Date().toISOString(),
      via: "ui",
      exitCode: r.exitCode,
      phase: mode === "cancel-snapshot" ? "snapshot" : "sql",
    },
  });
  return { r, audit };
}

describe("autoconnect cancel flow → audit-report.json", () => {
  it("cancel during snapshot phase → exitCode 4, rolled back, recorded", () => {
    const { r, audit } = auditFor("cancel-snapshot", 1);
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(4);
    expect(r.cancelled).toBe(true);
    expect(r.rolledBack).toBe(true);
    expect(audit.summary.exitCode).toBe(4);
    expect(audit.summary.rollbackStatus).toBe("cancelled");
    expect(audit.input.cancellation?.phase).toBe("snapshot");
    // Raw log must be persisted for debugging.
    expect(audit.input.rawLogJsonl).toMatch(/"step":"cancel"/);
    expect(audit.input.rawLogJsonl).toMatch(/"exitCode":4/);
  });

  it("cancel during SQL phase → exitCode 4, snapshot restored, recorded", () => {
    const { r, audit } = auditFor("cancel-sql", 1);
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(4);
    expect(r.cancelled).toBe(true);
    expect(r.rolledBack).toBe(true);
    expect(audit.summary.exitCode).toBe(4);
    expect(audit.summary.rollbackStatus).toBe("cancelled");
    expect(audit.input.cancellation?.phase).toBe("sql");
    expect(audit.input.rawLogJsonl).toMatch(/"step":"rollback_db"/);
  });

  it("audit JSON is serializable and round-trips exit code + phase", () => {
    const { audit } = auditFor("cancel-sql", 0);
    const json = JSON.parse(JSON.stringify(audit));
    expect(json.summary.exitCode).toBe(4);
    expect(json.summary.rollbackStatus).toBe("cancelled");
    expect(json.input.cancellation.phase).toBe("sql");
    expect(json.input.cancellation.exitCode).toBe(4);
  });
});
