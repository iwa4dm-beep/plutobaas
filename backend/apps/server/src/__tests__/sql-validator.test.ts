import { describe, it, expect } from "vitest";
import { validateSql, splitStatements, stripLiterals } from "../lib/sql-validator.js";

describe("sql-validator", () => {
  it("strips comments and string literals without breaking semicolons", () => {
    const src = `select 1; -- comment; with semicolon
                 select '; not a delimiter'; /* also ; here */ select 2;`;
    const stmts = splitStatements(src);
    expect(stmts.map((s) => s.verb)).toEqual(["SELECT", "SELECT", "SELECT"]);
  });

  it("read-only rejects UPDATE / DELETE / INSERT / DDL", () => {
    for (const q of ["update t set x=1", "delete from t", "insert into t values (1)", "drop table t"]) {
      const r = validateSql(q, { readOnly: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/write_in_read_only/);
    }
  });

  it("read-only allows SELECT / WITH / EXPLAIN / SHOW / VALUES", () => {
    for (const q of ["select 1", "with x as (select 1) select * from x", "explain select 1", "show timezone", "values (1,2)"]) {
      expect(validateSql(q, { readOnly: true }).ok).toBe(true);
    }
  });

  it("blocks role/ACL/system statements even in write mode", () => {
    const blocked = [
      "grant all on t to public",
      "revoke all on t from anon",
      "set role postgres",
      "reset role",
      "alter role someone with superuser",
      "drop database whatever",
      "alter system set foo = bar",
      "create extension pg_stat_statements",
      "listen ch",
      "copy t to '/tmp/x'",
    ];
    for (const q of blocked) {
      const r = validateSql(q, { readOnly: false });
      expect(r.ok, `expected blocked: ${q}`).toBe(false);
    }
  });

  it("blocks patterns even when wrapped in extra whitespace / comments", () => {
    const q = "/* attempt */\n  SET   ROLE   postgres  ;";
    const r = validateSql(q, { readOnly: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/blocked_pattern/);
  });

  it("caps statement count", () => {
    const q = Array.from({ length: 30 }, () => "select 1").join(";");
    const r = validateSql(q, { readOnly: true, maxStatements: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too_many_statements/);
  });

  it("preserves dollar-quoted bodies safely", () => {
    const s = stripLiterals("select $$; not a stmt $$;");
    expect(s.trim().endsWith(";")).toBe(true);
    const stmts = splitStatements("select $$;$$; select 2;");
    expect(stmts.length).toBe(2);
  });
});
