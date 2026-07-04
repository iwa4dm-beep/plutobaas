// Phase 33 — Unit tests for the CDC filter grammar.
import { describe, expect, it } from "vitest";
import { parseCdcFilter, evaluateCdcFilter, CDC_OPS } from "../../../backend/apps/server/src/modules/cdc/filter";

describe("parseCdcFilter", () => {
  it("parses eq/neq/gt/gte/lt/lte", () => {
    for (const op of CDC_OPS.filter(o => o !== "in")) {
      const f = parseCdcFilter(`user_id=${op}.42`);
      expect(f).toEqual({ column: "user_id", op, value: "42" });
    }
  });

  it("parses in-list with parens", () => {
    expect(parseCdcFilter("status=in.(a,b,c)")).toEqual({
      column: "status", op: "in", value: ["a", "b", "c"],
    });
  });

  it("rejects unknown operator", () => {
    expect(() => parseCdcFilter("x=like.foo")).toThrow(/unsupported op/);
  });

  it("rejects invalid column name", () => {
    expect(() => parseCdcFilter("1bad=eq.42")).toThrow(/invalid column/);
    expect(() => parseCdcFilter("a b=eq.42")).toThrow(/invalid column/);
  });

  it("rejects missing '='", () => {
    expect(() => parseCdcFilter("useridEq.42")).toThrow();
  });
});

describe("evaluateCdcFilter", () => {
  it("eq / neq basics", () => {
    expect(evaluateCdcFilter({ column: "s", op: "eq",  value: "5" }, { s: "5" })).toBe(true);
    expect(evaluateCdcFilter({ column: "s", op: "eq",  value: "5" }, { s: "6" })).toBe(false);
    expect(evaluateCdcFilter({ column: "s", op: "neq", value: "5" }, { s: "6" })).toBe(true);
  });
  it("numeric ordering", () => {
    expect(evaluateCdcFilter({ column: "n", op: "gt", value: "10" }, { n: "12" })).toBe(true);
    expect(evaluateCdcFilter({ column: "n", op: "lt", value: "10" }, { n: "12" })).toBe(false);
  });
  it("in-list membership", () => {
    expect(evaluateCdcFilter({ column: "s", op: "in", value: ["a", "b"] }, { s: "b" })).toBe(true);
    expect(evaluateCdcFilter({ column: "s", op: "in", value: ["a", "b"] }, { s: "c" })).toBe(false);
  });
  it("missing column → non-matching (safe default)", () => {
    expect(evaluateCdcFilter({ column: "s", op: "eq", value: "x" }, {})).toBe(false);
  });
});
