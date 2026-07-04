// Phase 57 — SAML SSO helpers.
//
// In-memory IdP registry per workspace, minimal metadata XML validator,
// signed assertion → session mapping. This is intentionally a small
// pure-TS surface (no XML DOM lib) — good enough for contract-level
// tests and for handing off to a real signer (xml-crypto) in prod.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SamlProvider = {
  workspace_id: string;
  slug: string;                    // /auth/v4/saml/:slug
  display_name: string;
  entity_id: string;
  sso_url: string;                 // IdP SSO endpoint (HTTP-POST binding)
  x509_cert: string;               // base64 PEM body (no BEGIN/END)
  signing_secret: string;          // shared HMAC secret for the test signer
  attr_email: string;              // e.g. "email"
  attr_name?: string;
  created_at: number;
  updated_at: number;
};

const providers = new Map<string, SamlProvider>();          // key: `${ws}:${slug}`
const sessions = new Map<string, { workspace_id: string; user_email: string; expires_at: number }>();

function key(ws: string, slug: string) { return `${ws}:${slug}`; }

export type MetadataInput = {
  workspace_id: string;
  slug: string;
  display_name: string;
  metadata_xml: string;
  signing_secret?: string;
};

export function validateMetadataXml(xml: string): { ok: boolean; error?: string; entity_id?: string; sso_url?: string; cert?: string } {
  if (typeof xml !== "string" || xml.length < 32) return { ok: false, error: "metadata_too_short" };
  if (!xml.includes("<EntityDescriptor") && !xml.includes(":EntityDescriptor")) return { ok: false, error: "missing_entity_descriptor" };
  const entity = xml.match(/entityID\s*=\s*"([^"]+)"/)?.[1];
  const sso = xml.match(/Location\s*=\s*"([^"]+)"[^>]*Binding\s*=\s*"[^"]*HTTP-POST[^"]*"/)
    ?.[1] ?? xml.match(/Binding\s*=\s*"[^"]*HTTP-POST[^"]*"[^>]*Location\s*=\s*"([^"]+)"/)?.[1];
  const cert = xml.match(/<(?:ds:)?X509Certificate>([^<]+)<\/(?:ds:)?X509Certificate>/)?.[1]?.replace(/\s+/g, "");
  if (!entity) return { ok: false, error: "missing_entity_id" };
  if (!sso)    return { ok: false, error: "missing_sso_url" };
  if (!cert || cert.length < 32) return { ok: false, error: "missing_x509_cert" };
  return { ok: true, entity_id: entity, sso_url: sso, cert };
}

export function upsertProvider(input: MetadataInput): { ok: boolean; provider?: SamlProvider; error?: string } {
  const v = validateMetadataXml(input.metadata_xml);
  if (!v.ok) return { ok: false, error: v.error };
  const now = Date.now();
  const existing = providers.get(key(input.workspace_id, input.slug));
  const p: SamlProvider = {
    workspace_id: input.workspace_id,
    slug:         input.slug,
    display_name: input.display_name,
    entity_id:    v.entity_id!,
    sso_url:      v.sso_url!,
    x509_cert:    v.cert!,
    signing_secret: input.signing_secret ?? existing?.signing_secret ?? randomBytes(24).toString("hex"),
    attr_email:   "email",
    attr_name:    "name",
    created_at:   existing?.created_at ?? now,
    updated_at:   now,
  };
  providers.set(key(input.workspace_id, input.slug), p);
  return { ok: true, provider: p };
}

export function getProvider(ws: string, slug: string): SamlProvider | undefined {
  return providers.get(key(ws, slug));
}
export function listProviders(ws: string): SamlProvider[] {
  return [...providers.values()].filter((p) => p.workspace_id === ws);
}
export function removeProvider(ws: string, slug: string): boolean {
  return providers.delete(key(ws, slug));
}

// Test signer: base64(JSON(assertion)) . HMAC-SHA256(base64). Real deployments
// swap in xml-crypto; the plugin only depends on `signAssertion`/`verifyAssertion`.
export type SamlAssertion = {
  issuer: string;
  subject_email: string;
  subject_name?: string;
  audience: string;
  not_before: number;
  not_after: number;
  in_response_to?: string;
};

export function signAssertion(a: SamlAssertion, secret: string): string {
  const body = Buffer.from(JSON.stringify(a)).toString("base64url");
  const sig  = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyAssertion(token: string, secret: string): { ok: boolean; error?: string; assertion?: SamlAssertion } {
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, error: "malformed_assertion" };
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "bad_signature" };
  const assertion = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SamlAssertion;
  const now = Date.now();
  if (now < assertion.not_before) return { ok: false, error: "not_yet_valid" };
  if (now > assertion.not_after)  return { ok: false, error: "expired" };
  return { ok: true, assertion };
}

export function mapAssertionToSession(ws: string, assertion: SamlAssertion, ttl_ms = 60 * 60 * 1000): { session_id: string; expires_at: number } {
  const id = `sess_${randomBytes(16).toString("hex")}`;
  const expires_at = Date.now() + ttl_ms;
  sessions.set(id, { workspace_id: ws, user_email: assertion.subject_email, expires_at });
  return { session_id: id, expires_at };
}

export function readSession(id: string) { return sessions.get(id); }
export function revokeSession(id: string) { return sessions.delete(id); }

export function _resetSamlForTests() { providers.clear(); sessions.clear(); }
