// Phase 45 — Cron expression parsing + next-tick calc (unix cron subset).
//
// Supports the five-field unix cron syntax:
//   minute hour day-of-month month day-of-week
// Each field: '*' | number | list (a,b,c) | range (a-b) | step (*/n or a-b/n).
// No aliases like @hourly — the DB stores raw expressions; use "0 * * * *".

export type CronParts = { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number> };

const RANGES: Array<[string, number, number]> = [
  ["min", 0, 59], ["hour", 0, 23], ["dom", 1, 31], ["mon", 1, 12], ["dow", 0, 6],
];

function parseField(field: string, lo: number, hi: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in ${label}: ${part}`);
    let start = lo, end = hi;
    if (range !== "*") {
      const [a, b] = range.split("-").map(Number);
      if (!Number.isInteger(a)) throw new Error(`invalid ${label}: ${part}`);
      start = a; end = Number.isInteger(b) ? b : a;
    }
    if (start < lo || end > hi || start > end) throw new Error(`out of range ${label}: ${part}`);
    for (let i = start; i <= end; i += step) out.add(i);
  }
  return out;
}

export function parseCron(expr: string): CronParts {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expression must have 5 fields, got ${fields.length}`);
  const parts: Partial<CronParts> = {};
  RANGES.forEach(([k, lo, hi], i) => {
    (parts as Record<string, Set<number>>)[k] = parseField(fields[i], lo, hi, k);
  });
  return parts as CronParts;
}

/** Next occurrence at or after `from` (defaults to now + 1 min). */
export function nextRunAt(parts: CronParts, from: Date = new Date()): Date {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // Search up to 4 years ahead — enough for any valid combination.
  for (let i = 0; i < 60 * 24 * 366 * 4; i++) {
    if (parts.mon.has(d.getUTCMonth() + 1) &&
        parts.dom.has(d.getUTCDate()) &&
        parts.dow.has(d.getUTCDay()) &&
        parts.hour.has(d.getUTCHours()) &&
        parts.min.has(d.getUTCMinutes())) {
      return d;
    }
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error("no matching time within 4 years");
}
