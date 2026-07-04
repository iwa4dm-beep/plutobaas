// Phase 40 — SOC2 compliance surface: right-to-delete, data export,
// residency lookup, KMS key rotation ledger.
//
// Endpoints (gated by PLUTO_ENABLE_COMPLIANCE=1):
//   POST /compliance/v1/delete-me          — user schedules 30-day soft delete
//   GET  /compliance/v1/delete-me          — user checks status
//   POST /compliance/v1/delete-me/cancel   — user cancels if within window
//   GET  /compliance/v1/export-me          — GDPR data export (JSON)
//   GET  /compliance/v1/residency          — workspace region
//   POST /compliance/v1/residency          — admin sets region
//   GET  /compliance/v1/kms/keys           — list KMS key versions
//   POST /compliance/v1/kms/rotate         — service-role: mark a new active version

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { q } from "../../lib/pgraw.js";
import { requireApiKey, requireServiceRole, requireWorkspaceAdmin } from "../../lib/apikey.js";

export const compliancePlugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_COMPLIANCE !== "1") {
    app.log.info("[compliance] disabled (set PLUTO_ENABLE_COMPLIANCE=1 to enable)");
    return;
  }

  const uidFor = (req: { auth?: { user?: { sub?: string } | null } }) => req.auth?.user?.sub ?? null;

  app.post("/compliance/v1/delete-me", { preHandler: requireApiKey }, async (req, reply) => {
    const uid = uidFor(req);
    if (!uid) { reply.code(401); return { error: "auth_required" }; }
    const r = await q<{ id: string; scheduled_for: string }>(
      `insert into public.gdpr_delete_requests(user_id) values ($1::uuid)
       on conflict do nothing returning id, scheduled_for`, [uid]);
    if (!r.rows[0]) {
      const existing = await q(`select id, scheduled_for, status from public.gdpr_delete_requests
                                where user_id=$1::uuid and status in ('pending','processing')`, [uid]);
      return { existing: existing.rows[0] ?? null };
    }
    return r.rows[0];
  });

  app.get("/compliance/v1/delete-me", { preHandler: requireApiKey }, async (req, reply) => {
    const uid = uidFor(req);
    if (!uid) { reply.code(401); return { error: "auth_required" }; }
    const r = await q(`select id, status, requested_at, scheduled_for, completed_at
                       from public.gdpr_delete_requests where user_id=$1::uuid
                       order by requested_at desc limit 5`, [uid]);
    return { requests: r.rows };
  });

  app.post("/compliance/v1/delete-me/cancel", { preHandler: requireApiKey }, async (req, reply) => {
    const uid = uidFor(req);
    if (!uid) { reply.code(401); return { error: "auth_required" }; }
    const r = await q(`update public.gdpr_delete_requests set status='cancelled'
                       where user_id=$1::uuid and status='pending' returning id`, [uid]);
    return { cancelled: r.rowCount };
  });

  app.get("/compliance/v1/export-me", { preHandler: requireApiKey }, async (req, reply) => {
    const uid = uidFor(req);
    if (!uid) { reply.code(401); return { error: "auth_required" }; }
    const user = await q(`select id, email, created_at from public.users where id=$1::uuid`, [uid]);
    const sessions = await q(`select id, created_at, last_used_at from public.refresh_tokens
                              where user_id=$1::uuid`, [uid]).catch(() => ({ rows: [] }));
    return {
      generated_at: new Date().toISOString(),
      user: user.rows[0] ?? null,
      sessions: sessions.rows,
      note: "Add app-specific tables here as they gain a user_id column.",
    };
  });

  app.get("/compliance/v1/residency", { preHandler: requireApiKey }, async (req) => {
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    const r = await q(`select region, updated_at from public.data_residency where workspace_id=$1::uuid`, [ws]);
    return r.rows[0] ?? { region: process.env.PLUTO_DEFAULT_REGION ?? "us-east-1" };
  });

  app.post("/compliance/v1/residency", { preHandler: requireWorkspaceAdmin }, async (req) => {
    const b = z.object({ region: z.string().min(2).max(40) }).parse(req.body);
    const ws = (req.headers["x-workspace-id"] as string) ?? null;
    await q(
      `insert into public.data_residency(workspace_id, region, updated_by)
       values ($1::uuid, $2, $3::uuid)
       on conflict (workspace_id) do update set region=excluded.region, updated_at=now(), updated_by=excluded.updated_by`,
      [ws, b.region, uidFor(req)]);
    return { ok: true, region: b.region };
  });

  app.get("/compliance/v1/kms/keys", { preHandler: requireApiKey }, async () => {
    const r = await q(`select id, purpose, version, algo, active, created_at, rotated_at
                       from public.kms_key_versions order by purpose, version desc`);
    return { keys: r.rows };
  });

  app.post("/compliance/v1/kms/rotate", { preHandler: requireServiceRole }, async (req) => {
    const b = z.object({ purpose: z.string(), algo: z.string(),
                         public_jwk: z.record(z.string(), z.unknown()).optional(),
                         wrapped_dek: z.string().optional() }).parse(req.body);
    const v = await q<{ n: number | null }>(
      `select max(version) as n from public.kms_key_versions where purpose=$1`, [b.purpose]);
    const version = (v.rows[0]?.n ?? 0) + 1;
    await q(`update public.kms_key_versions set active=false, rotated_at=now() where purpose=$1`, [b.purpose]);
    const r = await q<{ id: string }>(
      `insert into public.kms_key_versions(purpose, version, algo, public_jwk, wrapped_dek)
       values ($1, $2, $3, $4::jsonb, $5) returning id`,
      [b.purpose, version, b.algo, b.public_jwk ? JSON.stringify(b.public_jwk) : null, b.wrapped_dek ?? null]);
    return { id: r.rows[0].id, purpose: b.purpose, version };
  });
};
