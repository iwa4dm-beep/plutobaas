// Phase 56 — Signed bindings and secrets injection.
// Bindings are named secret references that a WASM module receives at
// invocation time. Each binding is issued as a signed envelope
// `{name, value_ciphertext, exp, sig}`; the runtime rejects any binding
// whose name isn't on the module's allowlist or whose signature/expiry is
// invalid. `value_ciphertext` uses AES-GCM keyed by a per-workspace secret,
// so leaking a signed envelope alone does not disclose the value.
import { createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

export type BindingEnvelope = {
  name: string;
  value_b64: string;      // AES-GCM ciphertext (nonce ‖ tag ‖ ct)
  exp: number;            // ms epoch
  sig: string;            // hex HMAC-SHA256 over `${name}.${value_b64}.${exp}`
};

const secretRegistry = new Map<string, string>(); // workspace -> master secret (hex)
const allowlists = new Map<string, Set<string>>(); // `${workspace}/${module}` -> allowed names

function keyFor(workspace: string): Buffer {
  let master = secretRegistry.get(workspace);
  if (!master) { master = randomBytes(32).toString("hex"); secretRegistry.set(workspace, master); }
  return createHash("sha256").update(master).digest();
}

export function setMasterSecret(workspace: string, hex64: string): void {
  if (!/^[0-9a-f]{64}$/i.test(hex64)) throw new Error("invalid_master_secret");
  secretRegistry.set(workspace, hex64);
}

export function setBindingAllowlist(workspace: string, module: string, names: string[]): void {
  allowlists.set(`${workspace}/${module}`, new Set(names));
}

function encrypt(workspace: string, plaintext: string): string {
  const key = keyFor(workspace);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ct]).toString("base64");
}

function decrypt(workspace: string, valueB64: string): string {
  const buf = Buffer.from(valueB64, "base64");
  const nonce = buf.subarray(0, 12); const tag = buf.subarray(12, 28); const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyFor(workspace), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function sign(workspace: string, name: string, valueB64: string, exp: number): string {
  const key = keyFor(workspace);
  return createHmac("sha256", key).update(`${name}.${valueB64}.${exp}`).digest("hex");
}

export function issueBinding(workspace: string, name: string, plaintext: string, ttl_ms = 60_000): BindingEnvelope {
  const exp = Date.now() + ttl_ms;
  const value_b64 = encrypt(workspace, plaintext);
  return { name, value_b64, exp, sig: sign(workspace, name, value_b64, exp) };
}

export type VerifyOk = { ok: true; name: string; value: string };
export type VerifyErr = { ok: false; error: string };

export function verifyAndOpen(workspace: string, module: string, env: BindingEnvelope): VerifyOk | VerifyErr {
  const allow = allowlists.get(`${workspace}/${module}`);
  if (!allow || !allow.has(env.name)) return { ok: false, error: "binding_not_allowed" };
  if (env.exp < Date.now()) return { ok: false, error: "binding_expired" };
  const expected = sign(workspace, env.name, env.value_b64, env.exp);
  const a = Buffer.from(expected, "hex"); const b = Buffer.from(env.sig, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "binding_bad_signature" };
  try { return { ok: true, name: env.name, value: decrypt(workspace, env.value_b64) }; }
  catch { return { ok: false, error: "binding_decrypt_failed" }; }
}

export function clearBindings(): void { secretRegistry.clear(); allowlists.clear(); }
