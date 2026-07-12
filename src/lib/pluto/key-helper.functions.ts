// Server functions: inspect the currently configured PLUTO_SERVICE_ROLE_KEY
// and, if it's not a JWT, mint one HS256-signed with PLUTO_JWT_SECRET so
// the Pluto admin API (fastify-jwt) accepts it.
//
// Uses Web Crypto (crypto.subtle) — no extra deps, Worker-compatible.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { detectKeyFormat, isAdminCompatible, describeKey, type KeyFormat } from "./key-helper";
import { getServiceRoleKey, getVpsBaseUrl } from "./vps-client";

export type KeyInspectResult = {
  hasKey: boolean;
  length: number;
  preview: string;                       // first 8 chars + …
  format: KeyFormat;
  description: string;
  adminCompatible: boolean;
  jwtSecretAvailable: boolean;           // whether PLUTO_JWT_SECRET is set
  vpsBaseUrl: string;
};

export const inspectServiceKey = createServerFn({ method: "GET" })
  .handler(async (): Promise<KeyInspectResult> => {
    const key = getServiceRoleKey() ?? "";
    const fmt = detectKeyFormat(key);
    return {
      hasKey: key.length > 0,
      length: key.length,
      preview: key ? `${key.slice(0, 8)}…` : "",
      format: fmt,
      description: describeKey(fmt),
      adminCompatible: isAdminCompatible(fmt),
      jwtSecretAvailable: !!process.env.PLUTO_JWT_SECRET,
      vpsBaseUrl: getVpsBaseUrl(),
    };
  });

// ---------- Mint an admin JWT from PLUTO_JWT_SECRET ----------

function b64urlEncode(buf: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof buf === "string") bytes = new TextEncoder().encode(buf);
  else if (buf instanceof Uint8Array) bytes = buf;
  else bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signHS256(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncode(sig);
}

const MintInput = z.object({
  role: z.enum(["service_role", "anon", "authenticated"]).default("service_role"),
  ttlSeconds: z.number().int().min(60).max(60 * 60 * 24 * 400).default(60 * 60 * 24 * 365), // 1y default
  issuer: z.string().max(120).optional(),
  extraClaims: z.record(z.string(), z.unknown()).optional(),
});

export type MintJwtResult =
  | { ok: true; token: string; role: string; expiresAt: number; header: unknown; payload: unknown }
  | { ok: false; error: string };

export const mintAdminJwt = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => MintInput.parse(d))
  .handler(async ({ data }): Promise<MintJwtResult> => {
    const secret = process.env.PLUTO_JWT_SECRET;
    if (!secret) {
      return {
        ok: false,
        error: "PLUTO_JWT_SECRET is not configured. Add it via Settings → Secrets (must match the Pluto backend's JWT_SECRET).",
      };
    }
    const now = Math.floor(Date.now() / 1000);
    const exp = now + data.ttlSeconds;
    const header  = { alg: "HS256", typ: "JWT" };
    const payload = {
      role: data.role,
      iss: data.issuer ?? "pluto-key-helper",
      iat: now,
      exp,
      ...(data.extraClaims ?? {}),
    };
    const h = b64urlEncode(JSON.stringify(header));
    const p = b64urlEncode(JSON.stringify(payload));
    const signingInput = `${h}.${p}`;
    const s = await signHS256(signingInput, secret);
    const token = `${signingInput}.${s}`;
    return { ok: true, token, role: data.role, expiresAt: exp, header, payload };
  });

// ---------- Live probe: does the currently configured key work against admin API? ----------

export type ProbeResult = {
  url: string;
  status: number;
  ok: boolean;
  bodyPreview: string;
  latencyMs: number;
};

const ProbeInput = z.object({
  token: z.string().min(10).optional(),   // if omitted, use configured PLUTO_SERVICE_ROLE_KEY
  path:  z.string().min(1).default("/admin/v1/workspaces?limit=1"),
});

export const probeAdminKey = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => ProbeInput.parse(d))
  .handler(async ({ data }): Promise<ProbeResult> => {
    const base = getVpsBaseUrl();
    const key = data.token ?? getServiceRoleKey() ?? "";
    const url = `${base}${data.path.startsWith("/") ? "" : "/"}${data.path}`;
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      return {
        url,
        status: res.status,
        ok: res.ok,
        bodyPreview: text.slice(0, 800),
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      return {
        url,
        status: 0,
        ok: false,
        bodyPreview: (e as Error).message,
        latencyMs: Date.now() - started,
      };
    }
  });
