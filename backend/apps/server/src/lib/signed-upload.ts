// Phase 49 — Signed upload tokens.
//
// HMAC-signed, single-use tokens that authorize a client to PUT bytes at a
// specific bucket/key with a bounded content-type and size. The token itself
// carries all state; the DB row is the revocation/consumption ledger.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const SECRET = process.env.PLUTO_STORAGE_SIGNING_SECRET ?? "dev-only-storage-secret";

export type UploadGrant = {
  bucket: string;
  object_key: string;
  content_type: string | null;
  max_bytes: number;
  expires_at: number; // epoch ms
  nonce: string;
};

function b64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(s: string) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string): string {
  return b64url(createHmac("sha256", SECRET).update(payload).digest());
}

export function mintUploadToken(grant: Omit<UploadGrant, "nonce">): string {
  const full: UploadGrant = { ...grant, nonce: randomBytes(12).toString("hex") };
  const body = b64url(Buffer.from(JSON.stringify(full)));
  const sig  = sign(body);
  return `${body}.${sig}`;
}

export function verifyUploadToken(token: string): UploadGrant | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const g = JSON.parse(fromB64url(body).toString("utf8")) as UploadGrant;
    if (g.expires_at < Date.now()) return null;
    return g;
  } catch { return null; }
}
