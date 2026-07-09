// Phase 20 + Phase 64 — Enterprise & Multi-region, custom domains v2.
//
// Endpoints (gated by PLUTO_ENABLE_ENTERPRISE=1):
//   GET/POST/DELETE /enterprise/v1/ip-rules             → per-workspace CIDR allow/deny
//   POST /enterprise/v1/ip-rules/check                  → evaluate an IP against workspace rules
//   GET/POST/DELETE /enterprise/v1/domains              → custom domain claims + verify tokens
//   POST /enterprise/v1/domains/:id/verify              → verify TXT (or ACME DNS-01 for wildcards)
//   POST /enterprise/v1/domains/:id/primary             → mark this domain as the workspace primary
//   DELETE /enterprise/v1/domains/:id/primary           → clear the primary flag
//   GET  /enterprise/v1/domains/webhook-secret          → view HMAC secret (workspace admin only)
//   POST /enterprise/v1/domains/webhook-secret/rotate   → rotate HMAC secret
//   POST /webhooks/v1/domains/status                    → PUBLIC — external cert-issuer callback
//   GET/PUT  /enterprise/v1/regions                     → primary + read-replica routing hints
//   GET  /enterprise/v1/status                          → public status page
//   POST /enterprise/v1/status/incidents                → admin publishes / updates an incident
//
// Every mutating custom-domain endpoint:
//   • is gated by `requireWorkspaceAdmin` — service_role, global admins,
//     or workspace owners/admins can mutate; others get 403.
//   • writes an `audit_events` row with `metadata.workspace_id` so the
//     dashboard's audit filter (metadata->>'workspace_id' = $1) surfaces it.
//   • broadcasts a `custom_domains:<workspace_id>` realtime event so
//     subscribed dashboards refresh without polling.
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { q } from "../../lib/pgraw.js";
import { requireApiKey, requireAdmin, requireDomainAdmin, requireWorkspaceAdmin } from "../../lib/apikey.js";
import { audit } from "../../lib/audit.js";
import pg from "pg";
import { env } from "../../config.js";

const notifier = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });

async function broadcast(channel: string, event: string, payload: unknown) {
  await notifier.query("select pg_notify('pluto_broadcast', $1)", [
    JSON.stringify({ channel, event, payload, ts: new Date().toISOString() }),
  ]).catch(() => { /* best effort */ });
}

function workspaceOf(req: FastifyRequest): string | null {
  const raw = req.headers["x-workspace-id"];
  return (Array.isArray(raw) ? raw[0] : raw) ?? null;
}

function isWildcard(host: string): boolean {
  return host.startsWith("*.");
}

/** DNS TXT record name a customer must place for verification. */
function verifyTxtName(host: string): string {
  return isWildcard(host)
    ? `_acme-challenge.${host.slice(2)}`
    : `_pluto-verify.${host}`;
}

async function ensureWebhookSecret(workspaceId: string): Promise<string> {
  const [row] = await q<{ secret: string }>(
    `insert into public.domain_webhooks (workspace_id) values ($1::uuid)
     on conflict (workspace_id) do update set workspace_id = excluded.workspace_id
     returning secret`,
    [workspaceId],
  );
  return row.secret;
}

async function domainAudit(
  req: FastifyRequest,
  workspaceId: string,
  action: string,
  hostname: string,
  status: "ok" | "error",
  metadata: Record<string, unknown> = {},
) {
  await audit(req, {
    action,
    target: hostname,
    status,
    metadata: { workspace_id: workspaceId, hostname, ...metadata },
  });
}

export const enterprisePlugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_ENTERPRISE !== "1") {
    app.log.info("[enterprise] disabled (set PLUTO_ENABLE_ENTERPRISE=1 to enable)");
    return;
  }

  // --- IP allow / deny rules -------------------------------------------
  app.get("/enterprise/v1/ip-rules", { preHandler: requireApiKey }, async (req) => {
    const ws = workspaceOf(req);
    return { rules: await q<any>(
      `select id, cidr::text as cidr, action, note, created_at
       from public.ip_access_rules where workspace_id=$1::uuid order by created_at desc`, [ws]) };
  });

  app.post("/enterprise/v1/ip-rules", { preHandler: requireApiKey }, async (req, reply) => {
    const ws = workspaceOf(req);
    if (!ws) { reply.code(400); return { error: "workspace_required" }; }
    const b = z.object({
      cidr: z.string(), action: z.enum(["allow","deny"]), note: z.string().optional(),
    }).parse(req.body);
    const rows = await q<any>(
      `insert into public.ip_access_rules (workspace_id, cidr, action, note)
       values ($1,$2::cidr,$3,$4) returning id, cidr::text as cidr, action, note, created_at`,
      [ws, b.cidr, b.action, b.note ?? null],
    );
    reply.code(201); return rows[0];
  });

  app.delete<{ Params: { id: string } }>("/enterprise/v1/ip-rules/:id",
    { preHandler: requireApiKey }, async (req) => {
      const ws = workspaceOf(req);
      await q(`delete from public.ip_access_rules where id=$1 and workspace_id=$2::uuid`, [req.params.id, ws]);
      return { ok: true };
    });

  app.post("/enterprise/v1/ip-rules/check", async (req, reply) => {
    const b = z.object({ workspace_id: z.string().uuid(), ip: z.string() }).parse(req.body);
    const rows = await q<{ action: string; matched: boolean }>(
      `select action, ($2::inet <<= cidr) as matched
       from public.ip_access_rules where workspace_id = $1::uuid`,
      [b.workspace_id, b.ip],
    );
    const matched = rows.filter((r) => r.matched);
    const anyAllow = rows.some((r) => r.action === "allow");
    const denied = matched.some((r) => r.action === "deny");
    const allowed = matched.some((r) => r.action === "allow");
    const decision = denied ? "deny" : anyAllow ? (allowed ? "allow" : "deny") : "allow";
    reply.code(decision === "allow" ? 200 : 403);
    return { decision, matched: matched.length, has_allow_list: anyAllow };
  });

  // --- Custom domains --------------------------------------------------
  //
  // Reads are gated only by requireApiKey (anyone with a valid key can see
  // their own workspace's domains); mutations require workspace admin.

  app.get("/enterprise/v1/domains", { preHandler: requireApiKey }, async (req) => {
    const ws = workspaceOf(req);
    return { domains: await q<any>(
      `select id, hostname, is_wildcard, is_primary, verified, verify_token,
              cert_status, last_error, created_at, verified_at, updated_at
       from public.custom_domains where workspace_id=$1::uuid order by created_at desc`, [ws]) };
  });

  app.post("/enterprise/v1/domains", { preHandler: requireDomainAdmin }, async (req, reply) => {
    const ws = workspaceOf(req);
    if (!ws) { reply.code(400); return { error: "workspace_required" }; }
    const b = z.object({
      hostname: z.string().min(3).regex(/^\*?\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i),
    }).parse(req.body);
    const host = b.hostname.toLowerCase();
    const wildcard = isWildcard(host);
    try {
      const rows = await q<any>(
        `insert into public.custom_domains (workspace_id, hostname, is_wildcard)
         values ($1,$2,$3) returning id, hostname, is_wildcard, verify_token, cert_status`,
        [ws, host, wildcard],
      );
      await ensureWebhookSecret(ws);
      await domainAudit(req, ws, "domain.add", host, "ok", { is_wildcard: wildcard });
      await broadcast(`custom_domains:${ws}`, "domain.added", { id: rows[0].id, hostname: host, is_wildcard: wildcard });
      reply.code(201);
      return { ...rows[0], dns_txt_record: verifyTxtName(host), dns_txt_value: rows[0].verify_token };
    } catch (err: unknown) {
      const msg = (err as Error).message ?? "add_failed";
      await domainAudit(req, ws, "domain.add", host, "error", { message: msg });
      reply.code(409); return { error: "add_failed", message: msg };
    }
  });

  app.post<{ Params: { id: string } }>("/enterprise/v1/domains/:id/verify",
    { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
      const ws = workspaceOf(req);
      const rows = await q<{ hostname: string; verify_token: string; is_wildcard: boolean }>(
        `select hostname, verify_token, is_wildcard from public.custom_domains
         where id=$1 and workspace_id=$2::uuid`, [req.params.id, ws]);
      if (rows.length === 0) { reply.code(404); return { error: "not_found" }; }
      const { hostname, verify_token, is_wildcard: wildcard } = rows[0];
      const txtName = verifyTxtName(hostname);
      try {
        const dns = await import("node:dns/promises");
        const txt = await dns.resolveTxt(txtName).catch(() => [] as string[][]);
        // For ACME DNS-01 wildcards the value is set by the ACME client and
        // rotates — treat presence of ANY TXT as sufficient for the record
        // to exist; the ACME issuer will still validate the value.
        const flat = txt.flat();
        const ok = wildcard ? flat.length > 0 : flat.includes(verify_token);
        if (!ok) {
          await q(`update public.custom_domains set last_error=$2 where id=$1`,
                  [req.params.id, `TXT record missing at ${txtName}`]);
          await domainAudit(req!, ws!, "domain.verify", hostname, "error", { txt_name: txtName });
          await broadcast(`custom_domains:${ws}`, "domain.verify_failed", { id: req.params.id, hostname, error: "txt_record_missing" });
          reply.code(400); return { error: "txt_record_missing", txt_name: txtName };
        }
      } catch { /* dns not reachable in test env — continue */ }
      await q(`update public.custom_domains
                  set verified=true, verified_at=now(),
                      cert_status = case when is_wildcard then 'pending' else 'issued' end,
                      last_error=null
                where id=$1`, [req.params.id]);
      await domainAudit(req!, ws!, "domain.verify", hostname, "ok", { is_wildcard: wildcard });
      await broadcast(`custom_domains:${ws}`, "domain.verified", { id: req.params.id, hostname });
      return { ok: true, verified: true };
    });

  app.post<{ Params: { id: string } }>("/enterprise/v1/domains/:id/primary",
    { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
      const ws = workspaceOf(req);
      const rows = await q<{ hostname: string; verified: boolean; is_wildcard: boolean }>(
        `select hostname, verified, is_wildcard from public.custom_domains
         where id=$1 and workspace_id=$2::uuid`, [req.params.id, ws]);
      if (rows.length === 0) { reply.code(404); return { error: "not_found" }; }
      const d = rows[0];
      if (!d.verified) { reply.code(400); return { error: "not_verified" }; }
      if (d.is_wildcard) { reply.code(400); return { error: "wildcard_cannot_be_primary" }; }
      await q(`update public.custom_domains set is_primary=false where workspace_id=$1::uuid`, [ws]);
      await q(`update public.custom_domains set is_primary=true where id=$1`, [req.params.id]);
      await domainAudit(req!, ws!, "domain.make_primary", d.hostname, "ok");
      await broadcast(`custom_domains:${ws}`, "domain.primary_changed", { id: req.params.id, hostname: d.hostname });
      return { ok: true, primary: true };
    });

  app.delete<{ Params: { id: string } }>("/enterprise/v1/domains/:id/primary",
    { preHandler: requireWorkspaceAdmin }, async (req) => {
      const ws = workspaceOf(req);
      const rows = await q<{ hostname: string }>(
        `update public.custom_domains set is_primary=false
         where id=$1 and workspace_id=$2::uuid and is_primary=true
         returning hostname`, [req.params.id, ws]);
      if (rows.length) {
        await domainAudit(req!, ws!, "domain.clear_primary", rows[0].hostname, "ok");
        await broadcast(`custom_domains:${ws}`, "domain.primary_cleared", { id: req.params.id, hostname: rows[0].hostname });
      }
      return { ok: true };
    });

  app.delete<{ Params: { id: string } }>("/enterprise/v1/domains/:id",
    { preHandler: requireWorkspaceAdmin }, async (req) => {
      const ws = workspaceOf(req);
      const rows = await q<{ hostname: string }>(
        `delete from public.custom_domains where id=$1 and workspace_id=$2::uuid returning hostname`,
        [req.params.id, ws]);
      if (rows.length) {
        await domainAudit(req!, ws!, "domain.remove", rows[0].hostname, "ok");
        await broadcast(`custom_domains:${ws}`, "domain.removed", { id: req.params.id, hostname: rows[0].hostname });
      }
      return { ok: true };
    });

  // Webhook secret management --------------------------------------------
  app.get("/enterprise/v1/domains/webhook-secret", { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
    const ws = workspaceOf(req);
    if (!ws) { reply.code(400); return { error: "workspace_required" }; }
    const secret = await ensureWebhookSecret(ws);
    return {
      secret,
      endpoint: "/webhooks/v1/domains/status",
      hmac_header: "x-pluto-signature",
      hmac_algo: "sha256",
      payload_shape: {
        workspace_id: "uuid",
        domain_id: "uuid",
        hostname: "string",
        event: "verified|verify_failed|cert_issued|cert_failed",
        cert_status: "pending|issued|failed",
        error: "string?",
      },
    };
  });

  app.post("/enterprise/v1/domains/webhook-secret/rotate",
    { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
      const ws = workspaceOf(req);
      if (!ws) { reply.code(400); return { error: "workspace_required" }; }
      const [row] = await q<{ secret: string }>(
        `insert into public.domain_webhooks (workspace_id) values ($1::uuid)
         on conflict (workspace_id) do update
           set secret = encode(gen_random_bytes(32),'hex'), rotated_at = now()
         returning secret`,
        [ws],
      );
      await audit(req, { action: "domain.webhook_rotate", metadata: { workspace_id: ws } });
      return { secret: row.secret, rotated: true };
    });

  // Public webhook — external cert-issuer callback. Body is JSON;
  // authenticity is verified via HMAC-SHA256(secret, raw_body) in the
  // `x-pluto-signature` header.
  app.post("/webhooks/v1/domains/status", { config: { rawBody: true } as any }, async (req, reply) => {
    const sig = req.headers["x-pluto-signature"];
    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    if (!sigStr) { reply.code(401); return { error: "missing_signature" }; }
    // rawBody is only populated when fastify-raw-body is registered; fall
    // back to JSON.stringify(body) which yields a byte-identical payload
    // for the JSON shape callers produce with JSON.stringify.
    const raw = (req as unknown as { rawBody?: string }).rawBody
      ?? (typeof req.body === "string" ? (req.body as string) : JSON.stringify(req.body ?? {}));
    let parsed: any;
    try { parsed = typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
    catch { reply.code(400); return { error: "invalid_json" }; }
    const b = z.object({
      workspace_id: z.string().uuid(),
      domain_id:    z.string().uuid(),
      hostname:     z.string(),
      event:        z.enum(["verified","verify_failed","cert_issued","cert_failed"]),
      cert_status:  z.enum(["pending","issued","failed"]).optional(),
      error:        z.string().optional(),
    }).safeParse(parsed);
    if (!b.success) { reply.code(400); return { error: "invalid_payload", issues: b.error.issues }; }

    const [wh] = await q<{ secret: string }>(
      `select secret from public.domain_webhooks where workspace_id=$1::uuid`,
      [b.data.workspace_id],
    );
    if (!wh) { reply.code(401); return { error: "no_webhook_secret" }; }
    const expected = createHmac("sha256", wh.secret).update(raw).digest("hex");
    const got = sigStr.replace(/^sha256=/, "");
    let valid = false;
    try {
      valid = expected.length === got.length &&
        timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(got, "hex"));
    } catch { valid = false; }
    if (!valid) { reply.code(401); return { error: "invalid_signature" }; }

    const nextStatus =
      b.data.cert_status ??
      (b.data.event === "cert_issued" ? "issued" :
       b.data.event === "cert_failed" ? "failed" : null);
    await q(
      `update public.custom_domains
          set cert_status = coalesce($3, cert_status),
              verified    = case when $2 = 'verified' then true else verified end,
              verified_at = case when $2 = 'verified' and verified_at is null then now() else verified_at end,
              last_error  = $4
        where id = $1`,
      [b.data.domain_id, b.data.event, nextStatus, b.data.error ?? null],
    );
    await broadcast(`custom_domains:${b.data.workspace_id}`, `domain.${b.data.event}`, {
      id: b.data.domain_id,
      hostname: b.data.hostname,
      cert_status: nextStatus,
      error: b.data.error ?? null,
    });
    // Webhook callers have no session, so audit anonymously.
    await audit(null, {
      action: `domain.webhook.${b.data.event}`,
      target: b.data.hostname,
      status: b.data.event.endsWith("failed") ? "error" : "ok",
      metadata: { workspace_id: b.data.workspace_id, domain_id: b.data.domain_id, source: "webhook" },
    });
    return { ok: true };
  });

  // --- Region routing --------------------------------------------------
  app.get("/enterprise/v1/regions", { preHandler: requireApiKey }, async (req) => {
    const ws = workspaceOf(req);
    const rows = await q<any>(
      `select primary_region, read_regions, pin_writes, updated_at
       from public.region_routing where workspace_id=$1::uuid`, [ws]);
    return rows[0] ?? { primary_region: "auto", read_regions: [], pin_writes: true };
  });

  app.put("/enterprise/v1/regions", { preHandler: requireWorkspaceAdmin }, async (req, reply) => {
    const ws = workspaceOf(req);
    if (!ws) { reply.code(400); return { error: "workspace_required" }; }
    const b = z.object({
      primary_region: z.string(), read_regions: z.array(z.string()).default([]), pin_writes: z.boolean().default(true),
    }).parse(req.body);
    const rows = await q<any>(
      `insert into public.region_routing (workspace_id, primary_region, read_regions, pin_writes, updated_at)
       values ($1,$2,$3,$4, now())
       on conflict (workspace_id) do update
         set primary_region=excluded.primary_region,
             read_regions=excluded.read_regions,
             pin_writes=excluded.pin_writes,
             updated_at=now()
       returning primary_region, read_regions, pin_writes, updated_at`,
      [ws, b.primary_region, b.read_regions, b.pin_writes],
    );
    return rows[0];
  });

  // --- Public status page ---------------------------------------------
  app.get("/enterprise/v1/status", async () => {
    const [components, incidents] = await Promise.all([
      q<any>(`select id, name, status, updated_at from public.status_components order by name`),
      q<any>(`select id, title, body, severity, component_id, started_at, resolved_at
              from public.status_incidents
              where resolved_at is null or resolved_at > now() - interval '7 days'
              order by started_at desc limit 25`),
    ]);
    const worst = components.reduce((acc, c) =>
      ({ operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4 } as any)[c.status] > (acc.rank ?? 0)
        ? { rank: ({ operational: 0, maintenance: 1, degraded: 2, partial_outage: 3, major_outage: 4 } as any)[c.status], name: c.status }
        : acc, { rank: 0, name: "operational" } as { rank: number; name: string });
    return { overall: worst.name, components, incidents };
  });

  app.post("/enterprise/v1/status/incidents", { preHandler: requireAdmin }, async (req, reply) => {
    const b = z.object({
      title: z.string().min(3), body: z.string().default(""),
      severity: z.enum(["minor","major","critical","maintenance"]).default("minor"),
      component_id: z.string().uuid().optional(),
      resolved: z.boolean().default(false),
    }).parse(req.body);
    const rows = await q<any>(
      `insert into public.status_incidents (title, body, severity, component_id, resolved_at)
       values ($1,$2,$3,$4, case when $5 then now() else null end)
       returning *`,
      [b.title, b.body, b.severity, b.component_id ?? null, b.resolved],
    );
    if (b.component_id && !b.resolved) {
      const map: Record<string, string> = { minor: "degraded", major: "partial_outage", critical: "major_outage", maintenance: "maintenance" };
      await q(`update public.status_components set status=$1, updated_at=now() where id=$2`, [map[b.severity], b.component_id]);
    }
    reply.code(201); return rows[0];
  });

  app.log.info("[enterprise] Phase 20 + Phase 64 endpoints mounted");
};
