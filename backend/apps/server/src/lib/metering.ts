// Server-side metering helper used by storage / functions / AI modules to
// record billable events and (optionally) enforce quota overage behavior.
// Behavior rules honoured from public.workspace_quotas.overage_behavior:
//   'allow' — record and return { ok: true }
//   'warn'  — record and return { ok: true, warn: true } when over soft/hard
//   'block' — return { ok: false, blocked: true } when hard limit exceeded
//             (event is NOT recorded so we never bill for a denied action)
import { q } from "./pgraw.js";

export type MeteredMetric =
  | "storage_gb" | "egress_gb" | "function_invocations"
  | "ai_tokens"  | "db_rows"   | "realtime_msgs";
export type MeteringEnv = "production" | "preview" | "development";

export interface MeterInput {
  workspaceId: string | null | undefined;
  metric: MeteredMetric;
  quantity: number;
  environment?: MeteringEnv;
  billingLabel?: string;
  meta?: Record<string, unknown>;
}

export interface MeterResult {
  ok: boolean;
  blocked?: boolean;
  warn?: boolean;
  over_soft?: boolean;
  over_hard?: boolean;
  used?: number;
  hard_limit?: number | null;
}

async function currentUsage(ws: string, metric: MeteredMetric, period: "day" | "month"): Promise<number> {
  const interval = period === "day" ? "1 day" : "30 days";
  const r = await q<{ total: string | null }>(
    `select coalesce(sum(quantity), 0)::text as total
     from public.usage_events
     where workspace_id=$1::uuid and metric=$2
       and observed_at > now() - interval '${interval}'`,
    [ws, metric]);
  return Number(r.rows[0]?.total ?? 0);
}

export async function recordUsage(input: MeterInput): Promise<MeterResult> {
  const ws = input.workspaceId;
  if (!ws) return { ok: true }; // no workspace context (system call) — skip

  const env = input.environment ?? "production";
  const label = input.billingLabel ?? null;

  // Check quota first (if any).
  const qrow = await q<{ hard_limit: number; soft_limit: number | null; period: string; overage_behavior: string; billing_label: string | null }>(
    `select hard_limit, soft_limit, period, overage_behavior, billing_label
     from public.workspace_quotas
     where workspace_id=$1::uuid and metric=$2
     order by case when period='day' then 0 else 1 end
     limit 1`, [ws, input.metric]);
  const quota = qrow.rows[0];

  if (quota) {
    const used = await currentUsage(ws, input.metric, (quota.period as "day" | "month") ?? "month");
    const projected = used + input.quantity;
    const overSoft = quota.soft_limit != null && projected > quota.soft_limit;
    const overHard = projected > quota.hard_limit;
    if (overHard && quota.overage_behavior === "block") {
      return { ok: false, blocked: true, over_soft: overSoft, over_hard: true, used, hard_limit: quota.hard_limit };
    }
    await q(
      `insert into public.usage_events (workspace_id, metric, quantity, meta, environment, billing_label)
       values ($1,$2,$3,$4::jsonb,$5,$6)`,
      [ws, input.metric, input.quantity, JSON.stringify(input.meta ?? {}), env, label ?? quota.billing_label]);
    return { ok: true, warn: (overSoft || overHard) && quota.overage_behavior !== "allow",
             over_soft: overSoft, over_hard: overHard, used: projected, hard_limit: quota.hard_limit };
  }

  await q(
    `insert into public.usage_events (workspace_id, metric, quantity, meta, environment, billing_label)
     values ($1,$2,$3,$4::jsonb,$5,$6)`,
    [ws, input.metric, input.quantity, JSON.stringify(input.meta ?? {}), env, label]);
  return { ok: true };
}

// Non-recording pre-flight check (e.g. before large uploads).
export async function checkQuota(ws: string, metric: MeteredMetric, quantity: number): Promise<MeterResult> {
  const qrow = await q<{ hard_limit: number; soft_limit: number | null; period: string; overage_behavior: string }>(
    `select hard_limit, soft_limit, period, overage_behavior
     from public.workspace_quotas where workspace_id=$1::uuid and metric=$2 limit 1`, [ws, metric]);
  const quota = qrow.rows[0];
  if (!quota) return { ok: true };
  const used = await currentUsage(ws, metric, (quota.period as "day" | "month") ?? "month");
  const projected = used + quantity;
  const overHard = projected > quota.hard_limit;
  const overSoft = quota.soft_limit != null && projected > quota.soft_limit;
  if (overHard && quota.overage_behavior === "block") {
    return { ok: false, blocked: true, over_soft: overSoft, over_hard: true, used, hard_limit: quota.hard_limit };
  }
  return { ok: true, warn: overSoft || overHard, over_soft: overSoft, over_hard: overHard, used, hard_limit: quota.hard_limit };
}
