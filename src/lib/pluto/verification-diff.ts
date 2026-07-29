// Compare two verification (smoke-test) runs of the same import job so an
// admin can see exactly which table/check changed between runs.
// Client-safe: pure functions, no server imports.
import type { SmokeCheck, SmokeReport } from "./smoke-types";

export type CheckDelta = {
  id: string;
  label: string;
  target: string;
  kind: "added" | "removed" | "status_changed" | "rows_changed" | "detail_changed";
  from: { status: string | null; rowCount: number | null; detail: string | null };
  to: { status: string | null; rowCount: number | null; detail: string | null };
};

export type VerificationDiff = {
  fromRun: number;
  toRun: number;
  changed: boolean;
  counts: { added: number; removed: number; status_changed: number; rows_changed: number; detail_changed: number };
  /** Distinct `schema.table` targets touched by any delta. */
  targets: string[];
  deltas: CheckDelta[];
  totals: {
    from: { pass: number; warn: number; fail: number };
    to: { pass: number; warn: number; fail: number };
  };
};

function side(c: SmokeCheck | undefined) {
  return {
    status: c ? c.status : null,
    rowCount: c ? c.rowCount : null,
    detail: c ? c.detail : null,
  };
}

const EMPTY = { pass: 0, warn: 0, fail: 0 };

/** Diff two smoke reports check-by-check (keyed on the stable check id). */
export function diffVerificationReports(
  from: SmokeReport | null,
  to: SmokeReport,
  fromRun = 0,
  toRun = 0,
): VerificationDiff {
  const prev = new Map((from?.checks ?? []).map((c) => [c.id, c]));
  const next = new Map(to.checks.map((c) => [c.id, c]));
  const deltas: CheckDelta[] = [];

  for (const [id, c] of next) {
    const before = prev.get(id);
    if (!before) {
      deltas.push({ id, label: c.label, target: c.target, kind: "added", from: side(undefined), to: side(c) });
      continue;
    }
    let kind: CheckDelta["kind"] | null = null;
    if (before.status !== c.status) kind = "status_changed";
    else if (before.rowCount !== c.rowCount) kind = "rows_changed";
    else if (before.detail !== c.detail) kind = "detail_changed";
    if (kind) deltas.push({ id, label: c.label, target: c.target, kind, from: side(before), to: side(c) });
  }
  for (const [id, c] of prev) {
    if (!next.has(id)) {
      deltas.push({ id, label: c.label, target: c.target, kind: "removed", from: side(c), to: side(undefined) });
    }
  }

  const counts = { added: 0, removed: 0, status_changed: 0, rows_changed: 0, detail_changed: 0 };
  for (const d of deltas) counts[d.kind] += 1;

  return {
    fromRun,
    toRun,
    changed: deltas.length > 0,
    counts,
    targets: [...new Set(deltas.map((d) => d.target))].sort(),
    deltas: deltas.sort((a, b) => a.target.localeCompare(b.target) || a.id.localeCompare(b.id)),
    totals: { from: from?.counts ?? EMPTY, to: to.counts },
  };
}

export function describeDiff(d: VerificationDiff): string {
  if (!d.changed) return `No change vs run #${d.fromRun}`;
  const bits = Object.entries(d.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k.replace("_", " ")}`);
  return `${bits.join(" · ")} across ${d.targets.length} object(s) vs run #${d.fromRun}`;
}
