// Phase 57 — Playwright e2e for Auth v4 (SAML SSO + SCIM v2 + session isolation).
// Skips unless PLUTO_ENABLE_AUTH_V4=1 is set for the running server.
import { test, expect } from "@playwright/test";

const BASE = process.env.PLUTO_API_BASE ?? "http://localhost:8080";
const API_KEY = process.env.PLUTO_API_KEY ?? "dev-anon";
const enabled = process.env.PLUTO_ENABLE_AUTH_V4 === "1";
const WS_A = "00000000-0000-0000-0000-0000000000a1";
const WS_B = "00000000-0000-0000-0000-0000000000b2";
const H  = (ws = WS_A) => ({ apikey: API_KEY, "x-workspace-id": ws });
const HA = (ws = WS_A) => ({ ...H(ws), "x-role": "admin" });

const METADATA = `<?xml version="1.0"?><EntityDescriptor entityID="https://idp.e/e">
  <IDPSSODescriptor><KeyDescriptor><ds:X509Certificate>${"Q".repeat(64)}</ds:X509Certificate></KeyDescriptor>
  <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.e/sso"/>
  </IDPSSODescriptor></EntityDescriptor>`;

test.describe("auth v4 e2e", () => {
  test.skip(!enabled, "PLUTO_ENABLE_AUTH_V4 must be 1");

  test("SAML: admin upload, denied ACS on bad audience, ok on match", async ({ request }) => {
    const slug = `okta-${Date.now()}`;
    const secret = "s".repeat(32);
    const up = await request.post(`${BASE}/auth/v4/saml/providers`, {
      headers: HA(), data: { slug, display_name: "Okta", metadata_xml: METADATA, signing_secret: secret },
    });
    expect(up.ok()).toBeTruthy();

    // The e2e can't reach the in-memory signer, so we call the debug endpoint via the ACS
    // with a well-formed signed assertion using the shared secret we just set.
    const now = Date.now();
    const body = Buffer.from(JSON.stringify({
      issuer: "https://idp.e/e", subject_email: "u@e.io", audience: "https://app",
      not_before: now - 1000, not_after: now + 60_000,
    })).toString("base64url");
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    const assertion = `${body}.${sig}`;

    const bad = await request.post(`${BASE}/auth/v4/saml/${slug}/acs`, { headers: H(), data: { assertion, audience: "nope" } });
    expect(bad.status()).toBe(401);
    const ok = await request.post(`${BASE}/auth/v4/saml/${slug}/acs`, { headers: H(), data: { assertion, audience: "https://app" } });
    expect(ok.ok()).toBeTruthy();
  });

  test("SCIM: non-admin cannot create; admin lifecycle end-to-end", async ({ request }) => {
    const denied = await request.post(`${BASE}/auth/v4/scim/v2/Users`, { headers: H(), data: { userName: `x-${Date.now()}` } });
    expect(denied.status()).toBe(403);
    const userName = `u-${Date.now()}@e.io`;
    const created = await request.post(`${BASE}/auth/v4/scim/v2/Users`, { headers: HA(), data: { userName } });
    expect(created.status()).toBe(201);
    const id = (await created.json()).id;
    const patched = await request.patch(`${BASE}/auth/v4/scim/v2/Users/${id}`, {
      headers: HA(), data: { Operations: [{ op: "replace", path: "active", value: false }] },
    });
    expect((await patched.json()).active).toBe(false);
    const del = await request.delete(`${BASE}/auth/v4/scim/v2/Users/${id}`, { headers: HA() });
    expect(del.status()).toBe(204);
  });

  test("Session isolation: session bound to WS_A cannot resolve under WS_B", async ({ request }) => {
    // Mint a session by successful SAML ACS in WS_A.
    const slug = `iso-${Date.now()}`;
    const secret = "s".repeat(32);
    await request.post(`${BASE}/auth/v4/saml/providers`, {
      headers: HA(WS_A), data: { slug, display_name: "Iso", metadata_xml: METADATA, signing_secret: secret },
    });
    const now = Date.now();
    const body = Buffer.from(JSON.stringify({
      issuer: "https://idp.e/e", subject_email: "iso@e.io", audience: "aud",
      not_before: now - 1000, not_after: now + 60_000,
    })).toString("base64url");
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    const acs = await request.post(`${BASE}/auth/v4/saml/${slug}/acs`, {
      headers: H(WS_A), data: { assertion: `${body}.${sig}`, audience: "aud" },
    });
    const { session_id } = await acs.json();

    const bound = await request.get(`${BASE}/auth/v4/session/resolve`, { headers: { ...H(WS_A), "x-session-id": session_id } });
    expect(bound.ok()).toBeTruthy();
    const foreign = await request.get(`${BASE}/auth/v4/session/resolve`, { headers: { ...H(WS_B), "x-session-id": session_id } });
    expect(foreign.status()).toBe(401);
    expect((await foreign.json()).error).toBe("wrong_workspace");
  });
});
