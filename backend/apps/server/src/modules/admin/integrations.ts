// Integration health — Phase 15/16 module readiness probe.
//
// Reports per-module: enabled flag, migration presence, required DB
// tables & grants, provider/gateway readiness. Used by the dashboard
// integration health page and by CI smoke tests.
import type { FastifyInstance } from "fastify";
import { requireApiKey, requireAdmin } from "../../lib/apikey.js";
import { q } from "../../lib/pgraw.js";

type Check = { name: string; ok: boolean; detail?: string };
type ModuleReport = {
  module: string; enabled: boolean; env_flag: string;
  ready: boolean; checks: Check[]; endpoints: string[];
};

async function tableExists(name: string): Promise<boolean> {
  const r = await q<{ ok: boolean }>(
    `select exists(select 1 from information_schema.tables where table_schema='public' and table_name=$1) as ok`,
    [name]);
  return r.rows[0]?.ok === true;
}
async function hasGrant(table: string, role: string, priv: string): Promise<boolean> {
  const r = await q<{ ok: boolean }>(
    `select exists(select 1 from information_schema.role_table_grants
     where table_schema='public' and table_name=$1 and grantee=$2 and privilege_type=$3) as ok`,
    [table, role, priv.toUpperCase()]);
  return r.rows[0]?.ok === true;
}
async function extensionInstalled(name: string): Promise<boolean> {
  const r = await q<{ ok: boolean }>(
    `select exists(select 1 from pg_extension where extname=$1) as ok`, [name]);
  return r.rows[0]?.ok === true;
}

export async function integrationsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);
  app.addHook("preHandler", async (req, reply) => { requireAdmin(req, reply); });

  app.get("/integrations/health", async () => {
    const advOn = process.env.PLUTO_ENABLE_ADVANCED_AUTH === "1";
    const tplOn = process.env.PLUTO_ENABLE_TEMPLATES === "1";
    const aiOn  = process.env.PLUTO_ENABLE_AI === "1";
    const commsOn = process.env.PLUTO_ENABLE_COMMS === "1";

    const modules: ModuleReport[] = [];

    // --- MFA ---
    {
      const c: Check[] = [];
      c.push({ name: "table auth_mfa_factors", ok: await tableExists("auth_mfa_factors") });
      c.push({ name: "table auth_mfa_challenges", ok: await tableExists("auth_mfa_challenges") });
      c.push({ name: "table auth_recovery_codes", ok: await tableExists("auth_recovery_codes") });
      c.push({ name: "grant authenticated → auth_mfa_factors", ok: await hasGrant("auth_mfa_factors","authenticated","SELECT") });
      modules.push({
        module: "MFA (TOTP)", enabled: advOn, env_flag: "PLUTO_ENABLE_ADVANCED_AUTH=1",
        ready: advOn && c.every((x) => x.ok), checks: c,
        endpoints: ["/auth/v1/mfa/enroll", "/auth/v1/mfa/verify", "/auth/v1/mfa/challenge",
                    "/auth/v1/mfa/factors", "/auth/v1/mfa/recovery-codes"],
      });
    }
    // --- SSO ---
    {
      const c: Check[] = [];
      c.push({ name: "table auth_sso_providers", ok: await tableExists("auth_sso_providers") });
      c.push({ name: "table auth_sso_sessions", ok: await tableExists("auth_sso_sessions") });
      const prov = await q<{ c: string }>(`select count(*)::text as c from public.auth_sso_providers`).catch(() => null);
      c.push({ name: "configured providers", ok: true, detail: prov?.rows[0]?.c ?? "0" });
      modules.push({
        module: "SSO (OIDC + SAML CRUD)", enabled: advOn, env_flag: "PLUTO_ENABLE_ADVANCED_AUTH=1",
        ready: advOn && c[0]!.ok && c[1]!.ok, checks: c,
        endpoints: ["/auth/v1/sso/providers", "/auth/v1/sso/:slug/start", "/auth/v1/sso/:slug/callback"],
      });
    }
    // --- Push ---
    {
      const c: Check[] = [];
      c.push({ name: "table push_devices", ok: await tableExists("push_devices") });
      c.push({ name: "table push_messages", ok: await tableExists("push_messages") });
      c.push({ name: "grant pluto_jobs → push_messages", ok: await hasGrant("push_messages","pluto_jobs","UPDATE") });
      const driver = process.env.PLUTO_PUSH_DRIVER ?? "log";
      c.push({ name: `driver = ${driver}`, ok: true,
        detail: driver === "webhook" ? (process.env.PLUTO_PUSH_WEBHOOK_URL ? "URL configured" : "URL missing")
              : driver === "fcm" ? (process.env.PLUTO_FCM_SERVER_KEY ? "key configured" : "key missing")
              : "dev/test only" });
      modules.push({
        module: "Push notifications", enabled: advOn, env_flag: "PLUTO_ENABLE_ADVANCED_AUTH=1 + PLUTO_PUSH_DRIVER",
        ready: advOn && c[0]!.ok && c[1]!.ok, checks: c,
        endpoints: ["/push/v1/devices", "/push/v1/send", "/push/v1/messages"],
      });
    }
    // --- Templates ---
    {
      const c: Check[] = [];
      c.push({ name: "table comms_templates", ok: await tableExists("comms_templates") });
      modules.push({
        module: "Comms templates", enabled: tplOn, env_flag: "PLUTO_ENABLE_TEMPLATES=1",
        ready: tplOn && c[0]!.ok, checks: c,
        endpoints: ["/templates/v1", "/templates/v1/:slug/preview", "/templates/v1/:slug/activate/:version"],
      });
    }
    // --- AI + Vector ---
    {
      const c: Check[] = [];
      c.push({ name: "extension pgvector", ok: await extensionInstalled("vector") });
      c.push({ name: "table ai_providers", ok: await tableExists("ai_providers") });
      c.push({ name: "table ai_usage", ok: await tableExists("ai_usage") });
      c.push({ name: "table ai_embeddings_demo", ok: await tableExists("ai_embeddings_demo") });
      const gatewayReady = !!(process.env.LOVABLE_AI_KEY || process.env.LOVABLE_API_KEY || process.env.OPENAI_API_KEY);
      c.push({ name: "provider key present", ok: gatewayReady,
        detail: gatewayReady ? "LOVABLE_AI_KEY / OPENAI_API_KEY set" : "no provider key configured" });
      modules.push({
        module: "AI & Vector", enabled: aiOn, env_flag: "PLUTO_ENABLE_AI=1",
        ready: aiOn && gatewayReady && c[1]!.ok, checks: c,
        endpoints: ["/ai/v1/status","/ai/v1/embeddings","/ai/v1/chat/completions",
                    "/ai/v1/vector/:collection/search","/ai/v1/usage","/ai/v1/providers"],
      });
    }
    // --- Communications (Phase 14, included for completeness) ---
    {
      const c: Check[] = [];
      c.push({ name: "table comms_email_queue", ok: await tableExists("comms_email_queue") });
      c.push({ name: "table comms_deliveries", ok: await tableExists("comms_deliveries") });
      modules.push({
        module: "Communications (Phase 14)", enabled: commsOn, env_flag: "PLUTO_ENABLE_COMMS=1",
        ready: commsOn && c.every((x) => x.ok), checks: c,
        endpoints: ["/comms/v1/email", "/comms/v1/sms", "/comms/v1/webhooks"],
      });
    }
    // --- Scaling & Performance (Phase 17) ---
    {
      const scaleOn = process.env.PLUTO_ENABLE_SCALING === "1";
      const c: Check[] = [];
      c.push({ name: "table queue_jobs", ok: await tableExists("queue_jobs") });
      c.push({ name: "table cache_entries", ok: await tableExists("cache_entries") });
      c.push({ name: "table rate_limit_policies", ok: await tableExists("rate_limit_policies") });
      c.push({ name: "grant pluto_jobs → queue_jobs", ok: await hasGrant("queue_jobs","pluto_jobs","UPDATE") });
      modules.push({
        module: "Scaling & Performance", enabled: scaleOn, env_flag: "PLUTO_ENABLE_SCALING=1",
        ready: scaleOn && c.every((x) => x.ok), checks: c,
        endpoints: ["/queue/v1/:queue/enqueue","/queue/v1/:queue/dequeue","/queue/v1/jobs",
                    "/queue/v1/stats","/cache/v1/:key","/admin/v1/rate-limits"],
      });
    }
    // --- Observability & Compliance (Phase 18) ---
    {
      const obsOn = process.env.PLUTO_ENABLE_OBSERVABILITY === "1";
      const c: Check[] = [];
      c.push({ name: "table metrics_samples", ok: await tableExists("metrics_samples") });
      c.push({ name: "table trace_spans", ok: await tableExists("trace_spans") });
      c.push({ name: "table gdpr_requests", ok: await tableExists("gdpr_requests") });
      c.push({ name: "grant pluto_jobs → metrics_samples INSERT", ok: await hasGrant("metrics_samples","pluto_jobs","INSERT") });
      modules.push({
        module: "Observability & Compliance", enabled: obsOn, env_flag: "PLUTO_ENABLE_OBSERVABILITY=1",
        ready: obsOn && c.every((x) => x.ok), checks: c,
        endpoints: ["/obs/v1/metrics","/obs/v1/metrics/query","/obs/v1/spans",
                    "/obs/v1/traces/:traceId","/obs/v1/prometheus",
                    "/compliance/v1/gdpr","/compliance/v1/gdpr/:id/run"],
      });
    }

    const overall = modules.every((m) => !m.enabled || m.ready);
    return { ok: overall, generated_at: new Date().toISOString(), modules };
  });
}
