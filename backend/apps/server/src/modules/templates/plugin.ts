// Comms Templates — Phase 15.4.
// Versioned, workspace-scoped email/sms/push templates. Handlebars-lite:
// only `{{ var }}` substitution — no expressions, no HTML unescaping.
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { q } from "../../lib/pgraw.js";

function render(body: string, vars: Record<string, unknown>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key: string) => {
    const v = key.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), vars);
    return v == null ? "" : String(v);
  });
}

const upsertBody = z.object({
  slug: z.string().regex(/^[a-z0-9_.-]+$/).max(80),
  channel: z.enum(["email", "sms", "push"]),
  subject: z.string().max(300).optional().nullable(),
  body_text: z.string().max(20000).optional().nullable(),
  body_html: z.string().max(200000).optional().nullable(),
  variables: z.array(z.string()).default([]),
});

export const templatesPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (process.env.PLUTO_ENABLE_TEMPLATES !== "1") {
    app.log.info({ module: "templates" }, "templates disabled (set PLUTO_ENABLE_TEMPLATES=1 to enable)");
    return;
  }
  app.log.info({ module: "templates", phase: "15.4" }, "templates registered");

  app.get("/templates/v1", async (req) => {
    const r = await q(`select distinct on (slug) id, slug, channel, version, is_active, subject,
                       body_text, body_html, variables, created_at
                       from public.comms_templates where workspace_id=$1 and is_active=true
                       order by slug, version desc`, [req.auth!.workspaceId]);
    return { templates: r.rows };
  });

  app.post("/templates/v1", async (req, reply) => {
    const body = upsertBody.parse(req.body);
    const uid = req.auth?.user?.sub ?? null;
    const r = await q<{ id: string; version: number; created_at: Date }>(
      `insert into public.comms_templates (workspace_id, slug, channel, version, is_active,
        subject, body_text, body_html, variables, created_by)
       values ($1,$2,$3,1,true,$4,$5,$6,$7,$8)
       on conflict do nothing returning id, version, created_at`,
      [req.auth!.workspaceId, body.slug, body.channel, body.subject ?? null,
       body.body_text ?? null, body.body_html ?? null, JSON.stringify(body.variables), uid]);
    if (r.rows.length === 0) return reply.code(409).send({ error: "slug_exists" });
    return { id: r.rows[0]!.id, slug: body.slug, version: r.rows[0]!.version, created_at: r.rows[0]!.created_at };
  });

  app.get("/templates/v1/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const r = await q(`select id, slug, channel, version, is_active, subject, body_text, body_html, variables, created_at
                       from public.comms_templates where workspace_id=$1 and slug=$2 and is_active=true
                       order by version desc limit 1`, [req.auth!.workspaceId, slug]);
    if (r.rows.length === 0) return reply.code(404).send({ error: "not_found" });
    return r.rows[0];
  });

  app.get("/templates/v1/:slug/versions", async (req) => {
    const { slug } = req.params as { slug: string };
    const r = await q(`select id, version, is_active, created_at from public.comms_templates
                       where workspace_id=$1 and slug=$2 order by version desc`,
                       [req.auth!.workspaceId, slug]);
    return { versions: r.rows };
  });

  app.post("/templates/v1/:slug/versions", async (req) => {
    const { slug } = req.params as { slug: string };
    const body = upsertBody.omit({ slug: true }).parse(req.body);
    const uid = req.auth?.user?.sub ?? null;
    const cur = await q<{ v: number }>(`select coalesce(max(version),0) as v from public.comms_templates
                                        where workspace_id=$1 and slug=$2`, [req.auth!.workspaceId, slug]);
    const nextV = (cur.rows[0]!.v as number) + 1;
    // New versions default to inactive — activate explicitly.
    const r = await q<{ id: string; created_at: Date }>(
      `insert into public.comms_templates (workspace_id, slug, channel, version, is_active,
        subject, body_text, body_html, variables, created_by)
       values ($1,$2,$3,$4,false,$5,$6,$7,$8,$9) returning id, created_at`,
      [req.auth!.workspaceId, slug, body.channel, nextV, body.subject ?? null,
       body.body_text ?? null, body.body_html ?? null, JSON.stringify(body.variables), uid]);
    return { id: r.rows[0]!.id, version: nextV, created_at: r.rows[0]!.created_at };
  });

  app.post("/templates/v1/:slug/activate/:version", async (req, reply) => {
    const { slug, version } = req.params as { slug: string; version: string };
    const v = Number(version);
    const exists = await q(`select 1 from public.comms_templates where workspace_id=$1 and slug=$2 and version=$3`,
      [req.auth!.workspaceId, slug, v]);
    if (exists.rows.length === 0) return reply.code(404).send({ error: "not_found" });
    await q(`update public.comms_templates set is_active=(version=$3)
             where workspace_id=$1 and slug=$2`, [req.auth!.workspaceId, slug, v]);
    return { ok: true, active_version: v };
  });

  app.post("/templates/v1/:slug/preview", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { vars } = z.object({ vars: z.record(z.unknown()).default({}) }).parse(req.body);
    const r = await q<{ subject: string | null; body_text: string | null; body_html: string | null }>(
      `select subject, body_text, body_html from public.comms_templates
       where workspace_id=$1 and slug=$2 and is_active=true
       order by version desc limit 1`, [req.auth!.workspaceId, slug]);
    if (r.rows.length === 0) return reply.code(404).send({ error: "not_found" });
    const t = r.rows[0]!;
    return {
      subject: t.subject ? render(t.subject, vars) : null,
      body_text: t.body_text ? render(t.body_text, vars) : null,
      body_html: t.body_html ? render(t.body_html, vars) : null,
    };
  });

  app.delete("/templates/v1/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const r = await q(`delete from public.comms_templates where workspace_id=$1 and slug=$2`,
      [req.auth!.workspaceId, slug]);
    if (r.rowCount === 0) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });
};

export default templatesPlugin;
