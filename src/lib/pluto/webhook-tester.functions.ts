// Webhook tester — signs a payload the same way Pluto signs outbound
// deliveries, sends it, and reports every attempt (status, latency, response
// body) so retries and signature verification can be inspected live.
//
// Admin-only. Outbound targets are validated to block obvious SSRF pivots
// (loopback / link-local / RFC1918) unless the caller explicitly opts in.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePlutoAdmin } from "./admin-middleware";

export type DeliveryAttempt = {
  attempt: number;
  status: number | null;
  ok: boolean;
  durationMs: number;
  error?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  delayedMs: number;
};

export type WebhookTestResult = {
  ok: boolean;
  url: string;
  event: string;
  timestamp: string;
  signature: string;
  signedPayload: string;
  headers: Record<string, string>;
  attempts: DeliveryAttempt[];
  error?: string;
};

const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

const Input = z.object({
  url: z.string().url(),
  secret: z.string().max(512).default(""),
  event: z.string().min(1).max(120).default("test.ping"),
  payload: z.string().max(200_000).default("{}"),
  maxAttempts: z.number().int().min(1).max(6).default(3),
  backoffMs: z.number().int().min(0).max(30_000).default(500),
  timeoutMs: z.number().int().min(500).max(30_000).default(10_000),
  /** Force failures for the first N attempts to exercise retry logic. */
  simulateFailures: z.number().int().min(0).max(5).default(0),
  allowPrivateHost: z.boolean().default(false),
  signatureHeader: z.string().min(1).max(64).default("x-pluto-signature"),
});

export const testWebhookFn = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }): Promise<WebhookTestResult> => {
    const url = new URL(data.url);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const base: WebhookTestResult = {
      ok: false,
      url: data.url,
      event: data.event,
      timestamp,
      signature: "",
      signedPayload: "",
      headers: {},
      attempts: [],
    };

    if (!/^https?:$/.test(url.protocol)) {
      return { ...base, error: "Only http(s) URLs are allowed." };
    }
    if (!data.allowPrivateHost && PRIVATE_HOST.test(url.hostname)) {
      return { ...base, error: `Refusing to call private host "${url.hostname}". Enable "allow private host" if this is intentional.` };
    }

    let body = data.payload.trim() || "{}";
    try {
      const parsed = JSON.parse(body);
      body = JSON.stringify({ event: data.event, timestamp, data: parsed });
    } catch {
      return { ...base, error: "Payload is not valid JSON." };
    }

    const signedPayload = `${timestamp}.${body}`;
    const signature = data.secret ? `sha256=${await hmacSha256(data.secret, signedPayload)}` : "";

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-pluto-event": data.event,
      "x-pluto-timestamp": timestamp,
      "user-agent": "Pluto-Webhook-Tester/1.0",
    };
    if (signature) headers[data.signatureHeader] = signature;

    const attempts: DeliveryAttempt[] = [];
    let ok = false;

    for (let i = 1; i <= data.maxAttempts; i++) {
      const delayedMs = i === 1 ? 0 : data.backoffMs * 2 ** (i - 2);
      if (delayedMs) await new Promise((r) => setTimeout(r, Math.min(delayedMs, 30_000)));

      if (i <= data.simulateFailures) {
        attempts.push({
          attempt: i,
          status: null,
          ok: false,
          durationMs: 0,
          delayedMs,
          error: "Simulated failure (retry simulation)",
        });
        continue;
      }

      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), data.timeoutMs);
      try {
        const res = await fetch(data.url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
          redirect: "manual",
        });
        const text = (await res.text().catch(() => "")).slice(0, 2000);
        const resHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => { resHeaders[k] = v; });
        attempts.push({
          attempt: i,
          status: res.status,
          ok: res.ok,
          durationMs: Date.now() - started,
          delayedMs,
          responseBody: text,
          responseHeaders: resHeaders,
        });
        if (res.ok) { ok = true; break; }
      } catch (e) {
        attempts.push({
          attempt: i,
          status: null,
          ok: false,
          durationMs: Date.now() - started,
          delayedMs,
          error: (e as Error).name === "AbortError" ? `Timed out after ${data.timeoutMs}ms` : (e as Error).message,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    return { ...base, ok, signature, signedPayload, headers, attempts };
  });

/** Verify a signature the way a receiver should — for the "verify" tab. */
export const verifySignatureFn = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) =>
    z.object({
      secret: z.string().min(1).max(512),
      timestamp: z.string().min(1).max(32),
      body: z.string().max(200_000),
      signature: z.string().min(1).max(256),
      toleranceSeconds: z.number().int().min(0).max(86_400).default(300),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const expected = `sha256=${await hmacSha256(data.secret, `${data.timestamp}.${data.body}`)}`;
    const provided = data.signature.trim();
    let match = expected.length === provided.length;
    for (let i = 0; i < expected.length && match; i++) {
      if (expected[i] !== provided[i]) match = false;
    }
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(data.timestamp || 0));
    const fresh = Number.isFinite(age) && age <= data.toleranceSeconds;
    return {
      match,
      fresh,
      ageSeconds: Number.isFinite(age) ? age : null,
      expected,
      reason: match ? (fresh ? "Valid signature." : `Signature matches but the timestamp is ${age}s old (tolerance ${data.toleranceSeconds}s).`) : "Signature mismatch — check the secret and that the receiver signs `${timestamp}.${rawBody}`.",
    };
  });
