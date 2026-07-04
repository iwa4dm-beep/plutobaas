// Phase 36 — plan enforcement middleware.
//
// Wrap Fastify preHandlers to gate a route behind a feature flag or a
// numeric limit on the caller's workspace plan. Fails with a well-defined
// HTTP contract so SDK clients can react without parsing free-form errors.
//
//   402 Payment Required            — plan does not include the feature or limit=0
//   429 Too Many Requests           — usage counter would exceed plan limit
//
// Both responses use the shape:
//   { error: "plan_upgrade_required" | "plan_limit_exceeded",
//     feature?: string, limit_key?: string, limit?: number,
//     required_feature?: string, current_plan: "free" | "pro" | ... }

import type { FastifyReply, FastifyRequest } from "fastify";
import { getWorkspacePlan } from "../modules/billing/plugin.js";

const wsFor = (req: FastifyRequest): string | null =>
  (req.headers["x-workspace-id"] as string | undefined) ?? null;

export function requirePlanFeature(feature: string) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    const ws = wsFor(req);
    const plan = await getWorkspacePlan(ws);
    if (!plan.features?.[feature]) {
      reply.code(402);
      return reply.send({
        error: "plan_upgrade_required",
        required_feature: feature,
        current_plan: plan.code,
      });
    }
  };
}

/**
 * Gate on a numeric limit. `currentUsage` is a callback that returns the
 * current counter (rows in table, MB stored, etc.) — we let the route decide
 * what to measure since the middleware has no domain knowledge. A limit of
 * 0 or missing means the plan does not include the feature at all.
 */
export function requirePlanLimit(
  limitKey: string,
  currentUsage: (req: FastifyRequest) => Promise<number> | number,
  delta = 1,
) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    const ws = wsFor(req);
    const plan = await getWorkspacePlan(ws);
    const limit = Number(plan.limits?.[limitKey] ?? 0);
    if (limit <= 0) {
      reply.code(402);
      return reply.send({
        error: "plan_upgrade_required",
        limit_key: limitKey,
        current_plan: plan.code,
      });
    }
    const used = await currentUsage(req);
    if (used + delta > limit) {
      reply.code(429);
      return reply.send({
        error: "plan_limit_exceeded",
        limit_key: limitKey,
        limit,
        current: used,
        current_plan: plan.code,
      });
    }
  };
}
