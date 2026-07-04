// Phase 56 — Cron triggers with misfire handling.
// - Registers `(id, cron_expr, module, version)` schedules.
// - `tick(now)` walks every schedule and fires any run that's due, tracking
//   misfires (missed intervals while the worker was offline) up to
//   `misfire_grace_ms`; older misfires are dropped and reported.
//
// The parser supports the common 5-field cron subset used by pg_cron:
//   minute hour day-of-month month day-of-week
// Each field: `*`, integer, `*/N`, or comma list.

export type CronSchedule = {
  id: string;
  expr: string;
  module: string;
  version: number;
  last_run_at: number | null;
  misfire_grace_ms: number;
};

type ParsedField = number[] | "*";
type ParsedCron = { m: ParsedField; h: ParsedField; dom: ParsedField; mo: ParsedField; dow: ParsedField };

const schedules = new Map<string, CronSchedule>();

function parseField(spec: string, min: number, max: number): ParsedField {
  if (spec === "*") return "*";
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const step = part.match(/^\*\/(\d+)$/);
    if (step) {
      const s = parseInt(step[1]!, 10);
      for (let v = min; v <= max; v += s) out.add(v);
      continue;
    }
    const n = parseInt(part, 10);
    if (Number.isNaN(n) || n < min || n > max) throw new Error(`bad_cron_field:${part}`);
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron_needs_5_fields");
  return {
    m: parseField(parts[0]!, 0, 59),
    h: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    mo: parseField(parts[3]!, 1, 12),
    dow: parseField(parts[4]!, 0, 6),
  };
}

function matches(field: ParsedField, value: number): boolean {
  return field === "*" || field.includes(value);
}

function isDue(cron: ParsedCron, d: Date): boolean {
  return matches(cron.m, d.getUTCMinutes()) &&
    matches(cron.h, d.getUTCHours()) &&
    matches(cron.dom, d.getUTCDate()) &&
    matches(cron.mo, d.getUTCMonth() + 1) &&
    matches(cron.dow, d.getUTCDay());
}

export function upsertSchedule(input: Omit<CronSchedule, "last_run_at"> & { last_run_at?: number | null }): CronSchedule {
  parseCron(input.expr); // validate now, fail fast
  const s: CronSchedule = { ...input, last_run_at: input.last_run_at ?? null };
  schedules.set(s.id, s);
  return s;
}

export function removeSchedule(id: string): boolean { return schedules.delete(id); }
export function listSchedules(): CronSchedule[] { return [...schedules.values()]; }

export type CronFire = { id: string; module: string; version: number; fire_at: number; misfires_dropped: number };

/** Walk all schedules; return the list of runs to dispatch. */
export function tick(now: number = Date.now()): CronFire[] {
  const fires: CronFire[] = [];
  for (const s of schedules.values()) {
    const cron = parseCron(s.expr);
    const start = s.last_run_at ? Math.floor(s.last_run_at / 60_000) + 1 : Math.floor(now / 60_000);
    const cur = Math.floor(now / 60_000);
    let matched: number[] = [];
    for (let minute = start; minute <= cur; minute++) {
      if (isDue(cron, new Date(minute * 60_000))) matched.push(minute * 60_000);
    }
    if (matched.length === 0) continue;
    const grace = now - s.misfire_grace_ms;
    const kept = matched.filter((t) => t >= grace);
    const dropped = matched.length - kept.length;
    const fireAt = kept[kept.length - 1] ?? now;
    fires.push({ id: s.id, module: s.module, version: s.version, fire_at: fireAt, misfires_dropped: dropped });
    s.last_run_at = fireAt;
  }
  return fires;
}

export function clearCron(): void { schedules.clear(); }
