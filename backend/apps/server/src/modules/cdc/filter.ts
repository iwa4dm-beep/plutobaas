// Phase 33 — CDC filter parser.
//
// Subset of PostgREST's `column=op.value` grammar so subscribers can
// scope realtime `postgres_changes` events server-side. Kept intentionally
// small — an over-permissive parser is a foot-gun when filter output
// feeds a SQL-in-anger context (we still bind values, never interpolate,
// but validating operators up-front is cheap defense in depth).

import { z } from "zod";

export const CDC_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in"] as const;
export type CdcOp = (typeof CDC_OPS)[number];

export type CdcFilter = {
  column: string;   // matches /^[a-z_][a-z0-9_]{0,62}$/i
  op: CdcOp;
  value: string | string[];
};

const columnRe = /^[a-z_][a-z0-9_]{0,62}$/i;

const filterStringSchema = z.string().min(3).max(500);

/**
 * Parse `column=op.value` (or `column=in.(a,b,c)`).
 * Throws a descriptive Error on malformed input.
 */
export function parseCdcFilter(raw: string): CdcFilter {
  filterStringSchema.parse(raw);
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new Error("filter_syntax: missing '='");
  const column = raw.slice(0, eq);
  const rhs = raw.slice(eq + 1);
  if (!columnRe.test(column)) throw new Error("filter_syntax: invalid column");

  const dot = rhs.indexOf(".");
  if (dot <= 0) throw new Error("filter_syntax: missing '.' after operator");
  const opRaw = rhs.slice(0, dot);
  const valueRaw = rhs.slice(dot + 1);
  if (!(CDC_OPS as readonly string[]).includes(opRaw)) throw new Error(`filter_syntax: unsupported op '${opRaw}'`);
  const op = opRaw as CdcOp;

  if (op === "in") {
    // Expect (a,b,c) with optional surrounding parens.
    const stripped = valueRaw.startsWith("(") && valueRaw.endsWith(")")
      ? valueRaw.slice(1, -1) : valueRaw;
    if (!stripped) throw new Error("filter_syntax: empty in-list");
    const parts = stripped.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length === 0 || parts.length > 100) throw new Error("filter_syntax: in-list size");
    return { column, op, value: parts };
  }
  if (!valueRaw) throw new Error("filter_syntax: missing value");
  return { column, op, value: valueRaw };
}

/**
 * Evaluate a filter against a candidate row. Only the value being
 * compared needs to be present on the row; if the column is missing the
 * filter is considered non-matching (i.e., DELETE events without a full
 * OLD image will drop out — safe default).
 */
export function evaluateCdcFilter(f: CdcFilter, row: Record<string, unknown>): boolean {
  const v = row[f.column];
  if (v === undefined || v === null) return false;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  switch (f.op) {
    case "eq":  return s === String(f.value);
    case "neq": return s !== String(f.value);
    case "gt":  return numOrStr(s) >  numOrStr(String(f.value));
    case "gte": return numOrStr(s) >= numOrStr(String(f.value));
    case "lt":  return numOrStr(s) <  numOrStr(String(f.value));
    case "lte": return numOrStr(s) <= numOrStr(String(f.value));
    case "in":  return Array.isArray(f.value) ? f.value.includes(s) : false;
  }
}

function numOrStr(x: string): number | string {
  const n = Number(x);
  return Number.isFinite(n) ? n : x;
}
