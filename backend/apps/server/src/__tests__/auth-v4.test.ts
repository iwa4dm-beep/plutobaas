// Phase 57 — Auth v4 unit tests.
import { describe, it, expect, beforeEach } from "vitest";
import * as saml from "../lib/saml.js";
import * as scim from "../lib/scim.js";
import * as iso from "../lib/session-isolation.js";

const WS_A = "00000000-0000-0000-0000-00000000aaaa";
const WS_B = "00000000-0000-0000-0000-00000000bbbb";

const METADATA_OK = `<?xml version="1.0"?><EntityDescriptor entityID="https://idp.example.com/entity">
  <IDPSSODescriptor><KeyDescriptor><ds:X509Certificate>${"A".repeat(64)}</ds:X509Certificate></KeyDescriptor>
  <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso"/>
  </IDPSSODescriptor></EntityDescriptor>`;

beforeEach(() => { saml._resetSamlForTests(); scim._resetScimForTests(); iso._resetSessionsForTests(); });

describe("SAML metadata validation", () => {
  it("accepts well-formed metadata", () => {
    const r = saml.validateMetadataXml(METADATA_OK);
    expect(r.ok).toBe(true);
    expect(r.entity_id).toBe("https://idp.example.com/entity");
    expect(r.sso_url).toBe("https://idp.example.com/sso");
  });
  it("rejects metadata missing entity/cert/sso", () => {
    expect(saml.validateMetadataXml("").ok).toBe(false);
    expect(saml.validateMetadataXml("<EntityDescriptor/>").ok).toBe(false);
  });
});

describe("SAML assertion round-trip", () => {
  it("signs and verifies within validity window", () => {
    const r = saml.upsertProvider({ workspace_id: WS_A, slug: "okta", display_name: "Okta", metadata_xml: METADATA_OK, signing_secret: "s".repeat(32) });
    expect(r.ok).toBe(true);
    const now = Date.now();
    const token = saml.signAssertion({ issuer: r.provider!.entity_id, subject_email: "u@a.io", audience: "https://app", not_before: now - 1000, not_after: now + 10_000 }, r.provider!.signing_secret);
    const v = saml.verifyAssertion(token, r.provider!.signing_secret);
    expect(v.ok).toBe(true);
  });
  it("rejects tampered / expired / wrong-secret assertions", () => {
    const r = saml.upsertProvider({ workspace_id: WS_A, slug: "okta", display_name: "Okta", metadata_xml: METADATA_OK, signing_secret: "s".repeat(32) });
    const now = Date.now();
    const token = saml.signAssertion({ issuer: "x", subject_email: "u@a.io", audience: "aud", not_before: now - 2000, not_after: now - 1000 }, r.provider!.signing_secret);
    expect(saml.verifyAssertion(token, r.provider!.signing_secret).error).toBe("expired");
    const good = saml.signAssertion({ issuer: "x", subject_email: "u@a.io", audience: "aud", not_before: now - 1000, not_after: now + 10_000 }, r.provider!.signing_secret);
    expect(saml.verifyAssertion(good, "wrong-secret").error).toBe("bad_signature");
    expect(saml.verifyAssertion("garbage", r.provider!.signing_secret).error).toBe("malformed_assertion");
  });
});

describe("SCIM users + groups", () => {
  it("creates, patches deactivate, then hard-deletes and cascades group members", () => {
    const u = scim.createUser(WS_A, { userName: "alice@a.io", externalId: "ext1", emails: [{ value: "alice@a.io", primary: true }] });
    expect(u.active).toBe(true);
    const g = scim.createGroup(WS_A, { displayName: "eng", members: [{ value: u.id }] });
    expect(g.members).toHaveLength(1);
    const p = scim.patchUser(WS_A, u.id, [{ op: "replace", path: "active", value: false }]);
    expect(p.active).toBe(false);
    scim.deleteUser(WS_A, u.id);
    expect(scim.getGroup(WS_A, g.id)!.members).toHaveLength(0);
  });
  it("blocks duplicate userName per workspace but allows same name across workspaces", () => {
    scim.createUser(WS_A, { userName: "bob@a.io" });
    expect(() => scim.createUser(WS_A, { userName: "bob@a.io" })).toThrow(/user_exists/);
    expect(scim.createUser(WS_B, { userName: "bob@a.io" }).workspace_id).toBe(WS_B);
  });
  it("supports SCIM filter by userName / externalId", () => {
    scim.createUser(WS_A, { userName: "c@a.io", externalId: "e1" });
    scim.createUser(WS_A, { userName: "d@a.io", externalId: "e2" });
    expect(scim.listUsers(WS_A, { userName: "c@a.io" }).totalResults).toBe(1);
    expect(scim.listUsers(WS_A, { externalId: "e2" }).Resources[0].userName).toBe("d@a.io");
  });
});

describe("Session isolation policies", () => {
  it("resolves on the bound workspace and denies foreign use", () => {
    const s = iso.createSession(WS_A, "u@a.io", "member");
    expect(iso.resolveSession(s.id, WS_A).ok).toBe(true);
    const bad = iso.resolveSession(s.id, WS_B);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("wrong_workspace");
    // Denial should be visible in audit stream for the requested workspace.
    const evts = iso.listEvents(WS_B);
    expect(evts.find((e) => e.action === "session.reuse_denied")).toBeTruthy();
  });
  it("denies revoked and expired sessions", () => {
    const s = iso.createSession(WS_A, "u@a.io", "member", 5);
    iso.revokeSession(s.id);
    expect(iso.resolveSession(s.id, WS_A).ok).toBe(false);
    const s2 = iso.createSession(WS_A, "u@a.io", "member", 1);
    // Wait past expiry
    return new Promise((r) => setTimeout(r, 5)).then(() => {
      const r2 = iso.resolveSession(s2.id, WS_A);
      expect(r2.ok).toBe(false);
    });
  });
  it("checkAdmin logs both allow and deny paths", () => {
    const admin = iso.createSession(WS_A, "a@a.io", "admin");
    const member = iso.createSession(WS_A, "m@a.io", "member");
    expect(iso.checkAdmin(admin.id, WS_A).ok).toBe(true);
    expect(iso.checkAdmin(member.id, WS_A).ok).toBe(false);
    const evts = iso.listEvents(WS_A);
    expect(evts.some((e) => e.action === "admin.check" && e.status === "ok")).toBe(true);
    expect(evts.some((e) => e.action === "admin.check" && e.status === "denied")).toBe(true);
  });
});
