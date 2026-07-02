// Phase 19 — Developer Experience & Ecosystem
// Endpoints (all gated by PLUTO_ENABLE_DEVEX=1):
//   GET  /devex/v1/templates                 → published project templates (anon+auth)
//   POST /devex/v1/templates                 → publish (admin)
//   POST /devex/v1/tokens                    → mint personal access token (returns raw once)
//   GET  /devex/v1/tokens                    → list caller's tokens (hash only)
//   POST /devex/v1/tokens/:id/revoke         → revoke
//   GET/POST/DELETE /devex/v1/webhooks       → subscription CRUD
//   POST /devex/v1/webhooks/:id/test         → deliver a synthetic ping (HMAC signed)
//   GET  /devex/v1/webhooks/:id/deliveries   → last 50 attempts
//   GET/POST /devex/v1/plugins               → installed plugin catalog
//
// Webhooks sign every delivery with `X-Pluto-Signature: sha256=<hex>`;
// consumers verify with the secret returned on subscription create.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { q } from "../../lib/pgraw.js";
import { requireApiKey, requireAdmin } from "../../lib/apikey.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function deliver(url: string, secret: Buffer, event: string, payload: unknown) {
  const body = JSON.stringify({ event, payload, at: new Date().toISOString() });
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pluto-signature": `sha256=${sig}`, "x-pluto-event": event },
      body,
    });
    return { status_code: res.status, response_ms: Date.now() - started, error: null as string | null };
  } catch (e) {
    return { status_code: null, response_ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

export const devexPlugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_DEVEX !== "1") {
    app.log.info("[devex] disabled (set PLUTO_ENABLE_DEVEX=1 to enable)");
    return;
  }

  // --- Templates -----------------------------------------------------------
  app.get("/devex/v1/templates", async () =>
    ({ templates: await q<any>(`select * from public.project_templates where published = true order by created_at desc`) }));

  app.post("/devex/v1/templates", { preHandler: requireAdmin }, async (req, reply) => {
    const b = z.object({
      slug: z.string().min(2), name: z.string().min(2), description: z.string().default(""),
      category: z.string().default("starter"), manifest: z.record(z.unknown()).default({}),
      published: z.boolean().default(false),
    }).parse(req.body);
    const rows = await q<any>(
      `insert into public.project_templates (slug,name,description,category,manifest,published)
       values ($1,$2,$3,$4,$5::jsonb,$6)
       on conflict (slug) do update
         set name=excluded.name, description=excluded.description,
             category=excluded.category, manifest=excluded.manifest,
             published=excluded.published, updated_at=now()
       returning *`,
      [b.slug, b.name, b.description, b.category, JSON.stringify(b.manifest), b.published],
    );
    reply.code(201); return rows[0];
  });

  // --- Personal access tokens ---------------------------------------------
  app.post("/devex/v1/tokens", { preHandler: requireApiKey }, async (req, reply) => {
    const user = (req as any).authUser as { id: string } | undefined;
    if (!user?.id) { reply.code(401); return { error: "unauthorized" }; }
    const b = z.object({
      name: z.string().min(1), scopes: z.array(z.string()).default(["read"]),
      workspace_id: z.string().uuid().optional(), expires_in_days: z.number().int().positive().max(365).optional(),
    }).parse(req.body);
    const raw = `plt_${randomBytes(24).toString("base64url")}`;
    const hash = sha256(raw);
    const expiresAt = b.expires_in_days ? new Date(Date.now() + b.expires_in_days * 864e5).toISOString() : null;
    const rows = await q<any>(
      `insert into public.personal_access_tokens (user_id, workspace_id, name, token_hash, scopes, expires_at)
       values ($1,$2,$3,$4,$5,$6) returning id, name, scopes, expires_at, created_at`,
      [user.id, b.workspace_id ?? null, b.name, hash, b.scopes, expiresAt],
    );
    reply.code(201);
    return { token: raw, meta: rows[0], warning: "Store this token securely — it will not be shown again." };
  });

  app.get("/devex/v1/tokens", { preHandler: requireApiKey }, async (req) => {
    const user = (req as any).authUser as { id: string } | undefined;
    if (!user?.id) return { tokens: [] };
    return {
      tokens: await q<any>(
        `select id,name,scopes,last_used_at,expires_at,revoked_at,created_at
         from public.personal_access_tokens where user_id=$1 order by created_at desc`,
        [user.id],
      ),
    };
  });

  app.post<{ Params: { id: string } }>("/devex/v1/tokens/:id/revoke",
    { preHandler: requireApiKey }, async (req) => {
      const user = (req as any).authUser as { id: string } | undefined;
      await q(`update public.personal_access_tokens set revoked_at=now()
               where id=$1 and user_id=$2 and revoked_at is null`, [req.params.id, user?.id]);
      return { ok: true };
    });

  // --- Webhook subscriptions ---------------------------------------------
  app.get("/devex/v1/webhooks", { preHandler: requireApiKey }, async (req) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    return {
      subscriptions: await q<any>(
        `select id, target_url, event_types, active, failure_count, created_at
         from public.webhook_subscriptions where workspace_id = $1::uuid order by created_at desc`,
        [ws],
      ),
    };
  });

  app.post("/devex/v1/webhooks", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    if (!ws) { reply.code(400); return { error: "workspace_required" }; }
    const b = z.object({
      target_url: z.string().url(), event_types: z.array(z.string()).default(["*"]),
    }).parse(req.body);
    const secret = randomBytes(32);
    const rows = await q<any>(
      `insert into public.webhook_subscriptions (workspace_id, target_url, event_types, secret)
       values ($1,$2,$3,$4) returning id, target_url, event_types, active, created_at`,
      [ws, b.target_url, b.event_types, secret],
    );
    reply.code(201);
    return { ...rows[0], secret: secret.toString("hex"), note: "Secret shown once — used to sign HMAC deliveries." };
  });

  app.delete<{ Params: { id: string } }>("/devex/v1/webhooks/:id",
    { preHandler: requireApiKey }, async (req) => {
      const ws = (req.headers["x-workspace-id"] as string) ?? null;
      await q(`delete from public.webhook_subscriptions where id=$1 and workspace_id=$2::uuid`, [req.params.id, ws]);
      return { ok: true };
    });

  app.post<{ Params: { id: string } }>("/devex/v1/webhooks/:id/test",
    { preHandler: requireApiKey }, async (req, reply) => {
      const ws = (req.headers["x-workspace-id"] as string) ?? null;
      const rows = await q<any>(
        `select id, target_url, secret from public.webhook_subscriptions
         where id=$1 and workspace_id=$2::uuid and active=true`,
        [req.params.id, ws],
      );
      if (rows.length === 0) { reply.code(404); return { error: "not_found" }; }
      const sub = rows[0];
      const result = await deliver(sub.target_url, sub.secret, "ping", { hello: "from pluto" });
      await q(
        `insert into public.webhook_deliveries (subscription_id, event_type, payload, status_code, response_ms, error)
         values ($1,'ping','{"hello":"from pluto"}'::jsonb,$2,$3,$4)`,
        [sub.id, result.status_code, result.response_ms, result.error],
      );
      return result;
    });

  app.get<{ Params: { id: string } }>("/devex/v1/webhooks/:id/deliveries",
    { preHandler: requireApiKey }, async (req) => ({
      deliveries: await q<any>(
        `select id, event_type, status_code, response_ms, error, attempted_at
         from public.webhook_deliveries where subscription_id=$1 order by attempted_at desc limit 50`,
        [req.params.id],
      ),
    }));

  // --- Plugin registry ---------------------------------------------------
  app.get("/devex/v1/plugins", { preHandler: requireApiKey }, async (req) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    return {
      installed: await q<any>(
        `select id, plugin_slug, version, config, enabled, installed_at
         from public.installed_plugins where workspace_id=$1::uuid order by installed_at desc`,
        [ws],
      ),
    };
  });

  app.post("/devex/v1/plugins", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    if (!ws) { reply.code(400); return { error: "workspace_required" }; }
    const b = z.object({
      plugin_slug: z.string(), version: z.string(),
      config: z.record(z.unknown()).default({}), enabled: z.boolean().default(true),
    }).parse(req.body);
    const rows = await q<any>(
      `insert into public.installed_plugins (workspace_id, plugin_slug, version, config, enabled)
       values ($1,$2,$3,$4::jsonb,$5)
       on conflict (workspace_id, plugin_slug) do update
         set version=excluded.version, config=excluded.config, enabled=excluded.enabled
       returning *`,
      [ws, b.plugin_slug, b.version, JSON.stringify(b.config), b.enabled],
    );
    reply.code(201); return rows[0];
  });

  app.log.info("[devex] Phase 19 endpoints mounted at /devex/v1/*");
};
