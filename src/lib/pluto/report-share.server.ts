// Signed, expiring share links for import job reports.
//
// A link carries an opaque token: base64url(payload).hex(HMAC-SHA256).
// The payload pins the job id, expiry, and who created it, so the token can be
// validated statelessly by the public endpoint. Tokens are single-purpose
// (read the report bundle of one job) and cannot be widened by the holder.
const ENC = new TextEncoder();

export type SharePayload = {
  /** job id */
  j: string;
  /** issued-at (unix seconds) */
  i: number;
  /** expires-at (unix seconds) */
  e: number;
  /** creator email, for the audit trail shown on the shared page */
  a?: string | null;
  /** include full SQL in the shared bundle */
  s?: boolean;
};

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    ENC.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await globalThis.crypto.subtle.sign("HMAC", key, ENC.encode(message)));
}

/** Signing secret: dedicated value, falling back to the ingest webhook secret. */
export function shareSecret(): string | null {
  return process.env.PLUTO_REPORT_SHARE_SECRET ?? process.env.PLUTO_IMPORT_WEBHOOK_SECRET ?? null;
}

export async function mintShareToken(payload: SharePayload, secret: string): Promise<string> {
  const body = b64url(ENC.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verifyShareToken(
  token: string,
  secret: string,
): Promise<{ ok: true; payload: SharePayload } | { ok: false; error: "malformed" | "bad_signature" | "expired" }> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, error: "malformed" };
  const expected = await hmac(secret, body);
  if (!timingSafeEqual(sig, expected)) return { ok: false, error: "bad_signature" };
  let payload: SharePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(unb64url(body))) as SharePayload;
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (!payload?.j || typeof payload.e !== "number") return { ok: false, error: "malformed" };
  if (payload.e * 1000 < Date.now()) return { ok: false, error: "expired" };
  return { ok: true, payload };
}
