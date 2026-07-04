// Phase 57 — Auth v4 integration tests via Fastify inject.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import * as saml from "../lib/saml.js";
import * as scim from "../lib/scim.js";
import * as iso from "../lib/session-isolation.js";

let app: FastifyInstance;
const WS = "00000000-0000-0000-0000-000000000abc";

const METADATA = `<?xml version="1.0"?><EntityDescriptor entityID="https://idp.example.com/e">
  <IDPSSODescriptor><KeyDescriptor><ds:X509Certificate>${"Z".repeat(64)}</ds:X509Certificate></KeyDescriptor>
  <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso"/>
  </IDPSSODescriptor></EntityDescriptor>`;

beforeAll(async () => {
  process.env.PLUTO_ENABLE_AUTH_V4 = "1";
  const { authV4Plugin } = await import("../modules/auth_v4/plugin.js");
  app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (req) => {
    (req as unknown as { auth: unknown }).auth = { workspaceId: WS };
  });
  await app.register(authV4Plugin);
  await app.ready();
});

beforeEach(() => { saml._resetSamlForTests(); scim._resetScimForTests(); iso._resetSessionsForTests(); });

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: method as "POST",
    url,
    headers: { apikey: "t", "content-type": "application/json", "x-workspace-id": WS, ...headers },
    payload: body ? JSON.stringify(body) : undefined,
  });
}

describe("auth_v4 — SAML SSO end-to-end", () => {
  it("admin uploads metadata, non-admin cannot; ACS mints workspace-bound session", async () => {
    const denied = await call("POST", "/auth/v4/saml/providers", { slug: "okta", display_name: "Okta", metadata_xml: METADATA, signing_secret: "s".repeat(32) });
    expect(denied.statusCode).toBe(403);

    const ok = await call("POST", "/auth/v4/saml/providers",
      { slug: "okta", display_name: "Okta", metadata_xml: METADATA, signing_secret: "s".repeat(32) },
      { "x-role": "admin" });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).provider).not.toHaveProperty("signing_secret");

    const bad = await call("POST", "/auth/v4/saml/providers",
      { slug: "bad", display_name: "Bad", metadata_xml: "<x/>" }, { "x-role": "admin" });
    expect(bad.statusCode).toBe(400);

    const now = Date.now();
    const prov = saml.getProvider(WS, "okta")!;
    const assertion = saml.signAssertion({ issuer: prov.entity_id, subject_email: "u@e.io", audience: "https://app", not_before: now - 1000, not_after: now + 10_000 }, prov.signing_secret);
    const acs = await call("POST", "/auth/v4/saml/okta/acs", { assertion, audience: "https://app" });
    expect(acs.statusCode).toBe(200);
    expect(JSON.parse(acs.body).session_id).toMatch(/^sid_/);

    const wrongAud = await call("POST", "/auth/v4/saml/okta/acs", { assertion, audience: "wrong" });
    expect(wrongAud.statusCode).toBe(401);
    expect(JSON.parse(wrongAud.body).error).toBe("audience_mismatch");

    const unknown = await call("POST", "/auth/v4/saml/nope/acs", { assertion, audience: "https://app" });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("auth_v4 — SCIM v2 CRUD", () => {
  it("full lifecycle: create → filter → patch(active=false) → delete", async () => {
    const c = await call("POST", "/auth/v4/scim/v2/Users", { userName: "u@e.io", externalId: "x1" }, { "x-role": "admin" });
    expect(c.statusCode).toBe(201);
    const id = JSON.parse(c.body).id;

    const list = await call("GET", `/auth/v4/scim/v2/Users?filter=${encodeURIComponent('userName eq "u@e.io"')}`);
    expect(JSON.parse(list.body).totalResults).toBe(1);

    const patch = await call("PATCH", `/auth/v4/scim/v2/Users/${id}`,
      { Operations: [{ op: "replace", path: "active", value: false }] }, { "x-role": "admin" });
    expect(JSON.parse(patch.body).active).toBe(false);

    const del = await call("DELETE", `/auth/v4/scim/v2/Users/${id}`, undefined, { "x-role": "admin" });
    expect(del.statusCode).toBe(204);
    const gone = await call("GET", `/auth/v4/scim/v2/Users/${id}`);
    expect(gone.statusCode).toBe(404);
  });
});

describe("auth_v4 — session isolation policy", () => {
  it("resolve denies cross-workspace reuse and emits audit event", async () => {
    const s = iso.createSession(WS, "u@e.io", "member");
    const ok = await call("GET", "/auth/v4/session/resolve", undefined, { "x-session-id": s.id });
    expect(ok.statusCode).toBe(200);

    const foreign = await call("GET", "/auth/v4/session/resolve", undefined,
      { "x-session-id": s.id, "x-workspace-id": "00000000-0000-0000-0000-00000000dead" });
    expect(foreign.statusCode).toBe(401);
    expect(JSON.parse(foreign.body).error).toBe("wrong_workspace");

    const audit = await call("GET", "/auth/v4/audit/events");
    const evts = JSON.parse(audit.body).events;
    expect(evts.some((e: { action: string }) => e.action === "session.create")).toBe(true);
  });
  it("missing session id → 400", async () => {
    const r = await call("GET", "/auth/v4/session/resolve");
    expect(r.statusCode).toBe(400);
  });
});
