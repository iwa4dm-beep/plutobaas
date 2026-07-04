// Phase 57 — Auth v4 plugin: SAML SSO, SCIM v2 provisioning, session isolation.
// Mount prefix `/auth/v4`. Enabled via PLUTO_ENABLE_AUTH_V4=1.
//
// Auth model:
// - All routes require an API key (workspace scoping via `x-workspace-id`
//   header; falls back to the API key's own workspace).
// - Mutating SAML/SCIM endpoints additionally require `x-role: admin`.
// - Session isolation endpoints require the caller to present a session id
//   via `x-session-id`; cross-workspace reuse is denied and audited.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireApiKey } from "../../lib/apikey.js";
import * as saml from "../../lib/saml.js";
import * as scim from "../../lib/scim.js";
import * as iso from "../../lib/session-isolation.js";

const enabled = process.env.PLUTO_ENABLE_AUTH_V4 === "1";

function ws(req: FastifyRequest): string {
  return (req.headers["x-workspace-id"] as string) || req.auth?.workspaceId || "default";
}
function requireAdminHeader(req: FastifyRequest, reply: FastifyReply): boolean {
  if ((req.headers["x-role"] as string) !== "admin") {
    reply.code(403); reply.send({ error: "admin_required" });
    iso.logAuth({ workspace_id: ws(req), user_email: null, action: "admin.header_check", status: "denied" });
    return false;
  }
  return true;
}

export async function authV4Plugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);
  app.log.info({ module: "auth_v4", phase: 57 }, "auth_v4 registered");

  // ---------- SAML SSO ---------------------------------------------------
  app.post("/auth/v4/saml/providers", async (req, reply) => {
    if (!requireAdminHeader(req, reply)) return;
    const p = z.object({
      slug: z.string().regex(/^[a-z0-9\-]{2,32}$/),
      display_name: z.string().min(1).max(128),
      metadata_xml: z.string().min(32),
      signing_secret: z.string().min(16).optional(),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const r = saml.upsertProvider({ workspace_id: ws(req), ...p.data });
    if (!r.ok) { reply.code(400); return { error: r.error }; }
    iso.logAuth({ workspace_id: ws(req), user_email: null, action: "saml.provider_upsert", status: "ok", meta: { slug: p.data.slug } });
    return { ok: true, provider: sanitize(r.provider!) };
  });

  app.get("/auth/v4/saml/providers", async (req) => ({
    providers: saml.listProviders(ws(req)).map(sanitize),
  }));

  app.delete("/auth/v4/saml/providers/:slug", async (req, reply) => {
    if (!requireAdminHeader(req, reply)) return;
    const slug = (req.params as { slug: string }).slug;
    const ok = saml.removeProvider(ws(req), slug);
    if (!ok) { reply.code(404); return { error: "not_found" }; }
    return { ok: true };
  });

  // Accept an assertion signed by the IdP's shared secret and mint a
  // workspace-bound session. Failure modes: unknown provider, bad
  // signature, expired assertion, audience mismatch.
  app.post("/auth/v4/saml/:slug/acs", async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const p = z.object({ assertion: z.string().min(4), audience: z.string().min(1) }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const prov = saml.getProvider(ws(req), slug);
    if (!prov) {
      iso.logAuth({ workspace_id: ws(req), user_email: null, action: "saml.acs", status: "denied", meta: { slug, reason: "unknown_provider" } });
      reply.code(404); return { error: "unknown_provider" };
    }
    const v = saml.verifyAssertion(p.data.assertion, prov.signing_secret);
    if (!v.ok) {
      iso.logAuth({ workspace_id: ws(req), user_email: null, action: "saml.acs", status: "denied", meta: { slug, reason: v.error } });
      reply.code(401); return { error: v.error };
    }
    if (v.assertion!.audience !== p.data.audience) {
      iso.logAuth({ workspace_id: ws(req), user_email: v.assertion!.subject_email, action: "saml.acs", status: "denied", meta: { slug, reason: "audience_mismatch" } });
      reply.code(401); return { error: "audience_mismatch" };
    }
    const session = iso.createSession(ws(req), v.assertion!.subject_email, "member");
    iso.logAuth({ workspace_id: ws(req), user_email: v.assertion!.subject_email, action: "saml.acs", status: "ok", meta: { slug } });
    return { ok: true, session_id: session.id, expires_at: session.expires_at };
  });

  // ---------- SCIM v2 ----------------------------------------------------
  app.get("/auth/v4/scim/v2/Users", async (req) => {
    const q = req.query as { filter?: string; startIndex?: string; count?: string };
    const filter: { userName?: string; externalId?: string; startIndex?: number; count?: number } = {};
    if (q.filter) {
      const m1 = q.filter.match(/userName eq \"([^\"]+)\"/);
      const m2 = q.filter.match(/externalId eq \"([^\"]+)\"/);
      if (m1) filter.userName = m1[1];
      if (m2) filter.externalId = m2[1];
    }
    if (q.startIndex) filter.startIndex = Number(q.startIndex);
    if (q.count)      filter.count      = Number(q.count);
    return scim.listUsers(ws(req), filter);
  });

  app.post("/auth/v4/scim/v2/Users", async (req, reply) => {
    if (!requireAdminHeader(req, reply)) return;
    try {
      const u = scim.createUser(ws(req), req.body as Partial<scim.ScimUser>);
      iso.logAuth({ workspace_id: ws(req), user_email: u.userName, action: "scim.user_create", status: "ok" });
      reply.code(201); return u;
    } catch (e) {
      const msg = (e as Error).message;
      reply.code(msg === "user_exists" ? 409 : 400); return { error: msg };
    }
  });

  app.get("/auth/v4/scim/v2/Users/:id", async (req, reply) => {
    const u = scim.getUser(ws(req), (req.params as { id: string }).id);
    if (!u) { reply.code(404); return { error: "not_found" }; }
    return u;
  });

  app.put("/auth/v4/scim/v2/Users/:id", async (req, reply) => {
    if (!requireAdminHeader(req, reply)) return;
    try {
      const u = scim.replaceUser(ws(req), (req.params as { id: string }).id, req.body as Partial<scim.ScimUser>);
      iso.logAuth({ workspace_id: ws(req), user_email: u.userName, action: "scim.user_replace", status: "ok" });
      return u;
    } catch (e) { reply.code(404); return { error: (e as Error).message }; }
  });

  app.patch("/auth/v4/scim/v2/Users/:id", async (req, reply) => {
    if (!requireAdminHeader(req, reply)) return;
    const body = req.body as { Operations?: scim.ScimPatchOp[] };
    if (!body?.Operations) { reply.code(400); return { error: "no_operations" }; }
    try {
      const u = scim.patchUser(ws(req), (req.params as { id: string }).id, body.Operations);
      iso.logAuth({ workspace_id: ws(req), user_email: u.userName, action: "scim.user_patch", status: "ok", meta: { active: u.active } });
      return u;
    } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });

  app.delete("/auth/v4/scim/v2/Users/:id", async (req, reply) => {
    if (!requireAdminHeader(req, reply)) return;
    const ok = scim.deleteUser(ws(req), (req.params as { id: string }).id);
    if (!ok) { reply.code(404); return { error: "not_found" }; }
    iso.logAuth({ workspace_id: ws(req), user_email: null, action: "scim.user_delete", status: "ok" });
    reply.code(204); return null;
  });

  app.get("/auth/v4/scim/v2/Groups",   async (req) => scim.listGroups(ws(req)));
  app.post("/auth/v4/scim/v2/Groups",  async (req, reply) => {
    if (!requireAdminHeader(req, reply)) return;
    try { reply.code(201); return scim.createGroup(ws(req), req.body as Partial<scim.ScimGroup>); }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.patch("/auth/v4/scim/v2/Groups/:id", async (req, reply) => {
    if (!requireAdminHeader(req, reply)) return;
    const body = req.body as { Operations?: scim.ScimPatchOp[] };
    if (!body?.Operations) { reply.code(400); return { error: "no_operations" }; }
    try { return scim.patchGroup(ws(req), (req.params as { id: string }).id, body.Operations); }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.delete("/auth/v4/scim/v2/Groups/:id", async (req, reply) => {
    if (!requireAdminHeader(req, reply)) return;
    const ok = scim.deleteGroup(ws(req), (req.params as { id: string }).id);
    if (!ok) { reply.code(404); return { error: "not_found" }; }
    reply.code(204); return null;
  });

  // ---------- Session isolation -----------------------------------------
  // Resolve the caller's session id against the requested workspace. Used
  // by downstream services to enforce workspace binding.
  app.get("/auth/v4/session/resolve", async (req, reply) => {
    const sid = req.headers["x-session-id"] as string | undefined;
    if (!sid) { reply.code(400); return { error: "missing_session_id" }; }
    const r = iso.resolveSession(sid, ws(req));
    if (!r.ok) { reply.code(401); return { error: r.error }; }
    return { ok: true, session: r.session };
  });

  app.post("/auth/v4/session/revoke", async (req, reply) => {
    const p = z.object({ session_id: z.string() }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    const ok = iso.revokeSession(p.data.session_id);
    if (!ok) { reply.code(404); return { error: "not_found" }; }
    return { ok: true };
  });

  app.get("/auth/v4/audit/events", async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 100);
    return { events: iso.listEvents(ws(req), limit) };
  });
}

function sanitize(p: saml.SamlProvider) {
  // Never leak the shared signing secret over the API surface.
  const { signing_secret: _s, ...safe } = p;
  return safe;
}
