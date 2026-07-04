// Phase 47 — DB-backed SLO evaluation (imports pgraw).
import { q } from "./pgraw.js";
import type { SloRow } from "./slo.js";

export async function evaluateErrorRatio(slo: SloRow, windowMinutes: number): Promise<{ total: number; bad: number; ratio: number }> {
  const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const kind = slo.kind;
  const thresh = slo.threshold_ms ?? 1000;
  const rows = await q<{ total: string; bad: string }>(
    `select count(*)::bigint as total,
            count(*) filter (where ${kind === "latency"
              ? "duration_ms > $4"
              : "status_code = 2"})::bigint as bad
       from public.obs_v2_spans
      where service = $1
        and name ~ $2
        and started_at >= $3::timestamptz`,
    [slo.service, slo.route_pattern, sinceIso, thresh],
  );
  const total = Number(rows[0]?.total ?? 0);
  const bad   = Number(rows[0]?.bad ?? 0);
  const ratio = total === 0 ? 0 : bad / total;
  return { total, bad, ratio };
}
