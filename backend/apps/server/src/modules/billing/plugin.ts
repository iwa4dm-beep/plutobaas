// Phase 36 — Stripe billing + plan enforcement.
//
// Endpoints (gated by PLUTO_ENABLE_BILLING=1):
//   GET  /billing/v1/plans                    — list active plans
//   GET  /billing/v1/subscription             — current workspace subscription
//   POST /billing/v1/checkout                 — { plan_code } → Stripe Checkout URL
//   POST /billing/v1/portal                   — Stripe customer portal URL
//   POST /billing/v1/webhook                  — Stripe webhook (raw body, sig verified)
//   POST /billing/v1/admin/set-plan           — service-role: forcibly set a workspace plan
//
// Enforcement helpers exported for other modules:
//   getWorkspacePlan(ws), planAllows(ws, feature), planLimit(ws, key)
//
// Stripe integration uses process.env.STRIPE_SECRET_KEY and
// STRIPE_WEBHOOK_SECRET. Without STRIPE_SECRET_KEY the module runs in
// "console" mode: checkout returns a stub URL and webhooks are ignored.
// This keeps local dev + tests working without live credentials.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { q } from "../../lib/pgraw.js";
import { requireApiKey, requireServiceRole, requireWorkspaceAdmin } from "../../lib/apikey.js";
import { verifyStripeSig } from "../../lib/stripe-sig.js";

// ---- Plan lookup / enforcement ---------------------------------------
type PlanRow = { code: string; features: Record<string, unknown>; limits: Record<string, number> };
const planCache = new Map<string, { p: PlanRow; expires: number }>();
const TTL_MS = 60_000;

export async function getWorkspacePlan(workspaceId: string | null): Promise<PlanRow> {
  const key = workspaceId ?? "root";
  const cached = planCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.p;
  const r = await q<PlanRow>(
    `select p.code, p.features, p.limits
     from public.billing_plans p
     left join public.billing_subscriptions s
       on s.plan_code = p.code and s.workspace_id = $1::uuid
     where s.workspace_id is not null and s.status in ('active','trialing')
     order by p.monthly_cents desc limit 1`, [workspaceId]);
  const p: PlanRow = r.rows[0] ?? { code: "free", features: {}, limits: {} };
  planCache.set(key, { p, expires: Date.now() + TTL_MS });
  return p;
}

export async function planAllows(workspaceId: string | null, feature: string): Promise<boolean> {
  const p = await getWorkspacePlan(workspaceId);
  return Boolean(p.features?.[feature]);
}

export async function planLimit(workspaceId: string | null, key: string): Promise<number> {
  const p = await getWorkspacePlan(workspaceId);
  const v = p.limits?.[key]; return typeof v === "number" ? v : 0;
}

function bustPlanCache(ws: string | null) { planCache.delete(ws ?? "root"); }

// ---- Stripe primitives (minimal, no SDK dep) -------------------------
async function stripeCall(path: string, method: "GET" | "POST", body?: Record<string, string>) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("stripe_not_configured");
  const form = body ? new URLSearchParams(body).toString() : undefined;
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const data = (await r.json()) as Record<string, unknown>;
  if (!r.ok) throw new Error(`stripe_${r.status}:${(data.error as { message?: string })?.message ?? "unknown"}`);
  return data;
}

// Stripe signs webhooks with HMAC-SHA256 over `{timestamp}.{payload}`.
function verifyStripeSig(sigHeader: string, payload: string, secret: string): boolean {
  const parts = Object.fromEntries(sigHeader.split(",").map((kv) => kv.split("=")));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const mac = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  try { return timingSafeEqual(Buffer.from(mac), Buffer.from(v1)); } catch { return false; }
}

// ---- Plugin ----------------------------------------------------------
export const billingPlugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_BILLING !== "1") {
    app.log.info("[billing] disabled (set PLUTO_ENABLE_BILLING=1 to enable)");
    return;
  }
  const wsFor = (req: { headers: Record<string, unknown> }) =>
    (req.headers["x-workspace-id"] as string) ?? null;

  app.get("/billing/v1/plans", { preHandler: requireApiKey }, async () => {
    const r = await q(`select code, name, monthly_cents, features, limits
                       from public.billing_plans where active order by monthly_cents`);
    return { plans: r.rows };
  });

  app.get("/billing/v1/subscription", { preHandler: requireApiKey }, async (req) => {
    const ws = wsFor(req);
    const r = await q(
      `select workspace_id, plan_code, status, current_period_end, stripe_customer_id
       from public.billing_subscriptions where workspace_id = $1::uuid`, [ws]);
    return { subscription: r.rows[0] ?? null, plan: await getWorkspacePlan(ws) };
  });

  app.post("/billing/v1/checkout", { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
    const b = z.object({ plan_code: z.string(), success_url: z.string().url(),
                         cancel_url: z.string().url() }).safeParse(req.body);
    if (!b.success) { reply.code(400); return { error: "bad_body" }; }
    const ws = wsFor(req);
    const plan = await q<{ stripe_price_id: string | null }>(
      `select stripe_price_id from public.billing_plans where code=$1 and active`, [b.data.plan_code]);
    if (!plan.rows[0]) { reply.code(404); return { error: "plan_not_found" }; }
    if (!process.env.STRIPE_SECRET_KEY || !plan.rows[0].stripe_price_id) {
      // Dev mode: return a stub URL and immediately mark the sub active.
      await q(
        `insert into public.billing_subscriptions(workspace_id, plan_code, status)
         values ($1::uuid, $2, 'active')
         on conflict (workspace_id) do update set plan_code=excluded.plan_code, status='active', updated_at=now()`,
        [ws, b.data.plan_code]);
      bustPlanCache(ws);
      return { url: `${b.data.success_url}?dev=1&plan=${b.data.plan_code}`, dev: true };
    }
    const session = await stripeCall("/checkout/sessions", "POST", {
      mode: "subscription",
      "line_items[0][price]": plan.rows[0].stripe_price_id!,
      "line_items[0][quantity]": "1",
      success_url: b.data.success_url,
      cancel_url: b.data.cancel_url,
      "metadata[workspace_id]": ws ?? "",
      "metadata[plan_code]": b.data.plan_code,
    });
    return { url: session.url };
  });

  app.post("/billing/v1/portal", { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
    const ws = wsFor(req);
    const s = await q<{ stripe_customer_id: string | null }>(
      `select stripe_customer_id from public.billing_subscriptions where workspace_id=$1::uuid`, [ws]);
    const cust = s.rows[0]?.stripe_customer_id;
    if (!cust) { reply.code(400); return { error: "no_customer" }; }
    const b = z.object({ return_url: z.string().url() }).parse(req.body);
    const session = await stripeCall("/billing_portal/sessions", "POST",
      { customer: cust, return_url: b.return_url });
    return { url: session.url };
  });

  // Raw-body webhook. Fastify parses JSON by default — register a raw parser
  // for this route so we can verify the signature.
  app.addContentTypeParser("application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body));

  app.post("/billing/v1/webhook", async (req, reply) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    const sig = req.headers["stripe-signature"] as string | undefined;
    const raw = Buffer.isBuffer(req.body) ? (req.body as Buffer).toString("utf8") : "";
    if (!secret || !sig || !verifyStripeSig(sig, raw, secret)) {
      reply.code(400); return { error: "bad_signature" };
    }
    let evt: { id: string; type: string; data: { object: Record<string, unknown> } };
    try { evt = JSON.parse(raw); }
    catch { reply.code(400); return { error: "bad_json" }; }

    // Idempotency: unique on stripe_event_id.
    const dup = await q(
      `insert into public.billing_events(type, stripe_event_id, payload)
       values ($1, $2, $3::jsonb) on conflict (stripe_event_id) do nothing returning id`,
      [evt.type, evt.id, JSON.stringify(evt)]);
    if (dup.rows.length === 0) return { ok: true, duplicate: true };

    const obj = evt.data.object;
    const meta = (obj.metadata ?? {}) as Record<string, string>;
    const ws = meta.workspace_id || null;
    if (evt.type === "checkout.session.completed" && ws) {
      await q(
        `insert into public.billing_subscriptions
          (workspace_id, plan_code, stripe_customer_id, stripe_subscription_id, status)
         values ($1::uuid, $2, $3, $4, 'active')
         on conflict (workspace_id) do update set
           plan_code=excluded.plan_code,
           stripe_customer_id=excluded.stripe_customer_id,
           stripe_subscription_id=excluded.stripe_subscription_id,
           status='active', updated_at=now()`,
        [ws, meta.plan_code || "pro", obj.customer, obj.subscription]);
      bustPlanCache(ws);
    } else if (evt.type === "customer.subscription.updated" || evt.type === "customer.subscription.deleted") {
      const status = evt.type === "customer.subscription.deleted" ? "canceled" : (obj.status as string);
      await q(
        `update public.billing_subscriptions
         set status=$1, current_period_end=to_timestamp($2), updated_at=now()
         where stripe_subscription_id=$3`,
        [status, obj.current_period_end, obj.id]);
      planCache.clear();
    }
    return { ok: true };
  });

  app.post("/billing/v1/admin/set-plan", { preHandler: requireServiceRole }, async (req) => {
    const b = z.object({ workspace_id: z.string().uuid(), plan_code: z.string() }).parse(req.body);
    await q(
      `insert into public.billing_subscriptions(workspace_id, plan_code, status)
       values ($1::uuid, $2, 'active')
       on conflict (workspace_id) do update set plan_code=excluded.plan_code, updated_at=now()`,
      [b.workspace_id, b.plan_code]);
    bustPlanCache(b.workspace_id);
    return { ok: true };
  });
};
