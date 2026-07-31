// Public ingest endpoint for the Pluto Migrator Chrome extension.
//
//   POST /api/public/pluto-import
//     headers:
//       x-pluto-timestamp: <unix seconds>
//       x-pluto-signature: sha256=<hex HMAC of `${timestamp}.${rawBody}`>
//     body: ImportJobPayload (see src/lib/pluto/import-jobs.server.ts)
//
// SECURITY
//  - HMAC-SHA256 with PLUTO_IMPORT_WEBHOOK_SECRET, timing-safe compared.
//  - ±5 minute timestamp window (replay window bound).
//  - event_id is UNIQUE in admin.import_jobs → durable replay protection.
//  - The endpoint only *records* a job + translated SQL. Nothing is executed
//    until an admin presses Dry-run / Apply in the dashboard.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { translateSupabaseSchema } from "@/lib/pluto/supabase-translate";

const Payload = z.object({
  event_id: z.string().min(8).max(200),
  source: z.enum(["lovable", "supabase", "github"]),
  repo: z.string().max(300).nullish(),
  ref: z.string().max(200).nullish(),
  zipball_url: z.string().url().max(1000).nullish(),
  lovable: z
    .object({ project_id: z.string().max(200).optional(), name: z.string().max(200).optional(), url: z.string().max(1000).optional() })
    .nullish(),
  supabase: z
    .object({
      ref: z.string().max(100).optional(),
      region: z.string().max(50).optional(),
      schema_sql: z.string().max(2_000_000).optional(),
      tables: z.array(z.string().max(200)).max(500).optional(),
    })
    .nullish(),
  target: z.object({ project_id: z.string().max(100).optional(), slug: z.string().max(80).optional() }).nullish(),
});

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sign(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function handle(request: Request): Promise<Response> {
  const secret = process.env.PLUTO_IMPORT_WEBHOOK_SECRET;
  if (!secret) {
    return json({ ok: false, error: "not_configured", hint: "Set PLUTO_IMPORT_WEBHOOK_SECRET in project secrets." }, 503);
  }

  const raw = await request.text();
  if (raw.length > 4_000_000) return json({ ok: false, error: "payload_too_large" }, 413);

  const ts = request.headers.get("x-pluto-timestamp") ?? "";
  const sig = (request.headers.get("x-pluto-signature") ?? "").replace(/^sha256=/i, "").trim();
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return json({ ok: false, error: "stale_or_missing_timestamp" }, 401);
  }
  const expected = await sign(secret, `${ts}.${raw}`);
  if (!sig || !timingSafeEqual(sig.toLowerCase(), expected)) {
    return json({ ok: false, error: "invalid_signature" }, 401);
  }

  // ---- resumable chunked upload envelope -----------------------------
  // { event_id, chunk: { upload_id, index, total, data }, envelope? }
  let anyBody: Record<string, unknown>;
  try {
    anyBody = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return json({ ok: false, error: "invalid_json", detail: (e as Error).message }, 400);
  }
  if (anyBody && typeof anyBody === "object" && anyBody.chunk) {
    const Chunk = z.object({
      event_id: z.string().min(8).max(200),
      chunk: z.object({
        upload_id: z.string().min(8).max(200),
        index: z.number().int().min(0).max(100_000),
        total: z.number().int().min(1).max(100_000),
        data: z.string().max(1_500_000),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).nullish(),
        full_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).nullish(),
      }),
      envelope: z.record(z.unknown()).optional(),
    });
    const c = Chunk.safeParse(anyBody);
    if (!c.success) return json({ ok: false, error: "invalid_chunk", detail: c.error.message }, 400);
    const { receiveChunk } = await import("@/lib/pluto/import-chunks.server");
    try {
      const r = await receiveChunk({
        upload_id: c.data.chunk.upload_id,
        event_id: c.data.event_id,
        index: c.data.chunk.index,
        total: c.data.chunk.total,
        data: c.data.chunk.data,
        sha256: c.data.chunk.sha256 ?? null,
        full_sha256: c.data.chunk.full_sha256 ?? null,
        envelope: c.data.envelope ?? null,
      });
      // 422 → integrity failure: client re-sends only `corrupt` indices.
      if (!r.ok) return json(r, 422);
      return json(r, r.job_id ? 202 : 200);
    } catch (e) {
      return json({ ok: false, error: "chunk_store_failed", detail: (e as Error).message }, 502);
    }
  }


  let parsed: z.infer<typeof Payload>;
  try {
    parsed = Payload.parse(anyBody);
  } catch (e) {
    return json({ ok: false, error: "invalid_payload", detail: (e as Error).message }, 400);
  }


  const schemaSql = parsed.supabase?.schema_sql ?? "";
  const translated = schemaSql ? translateSupabaseSchema(schemaSql) : null;

  const { createImportJob } = await import("@/lib/pluto/import-jobs.server");
  try {
    const { job, duplicate } = await createImportJob(parsed, translated?.sql ?? null);
    if (duplicate) return json({ ok: true, duplicate: true, event_id: parsed.event_id });
    return json(
      {
        ok: true,
        duplicate: false,
        job_id: job?.id,
        status: job?.status,
        translation: translated ? { stats: translated.stats, warnings: translated.warnings.slice(0, 25) } : null,
      },
      202,
    );
  } catch (e) {
    return json({ ok: false, error: "store_failed", detail: (e as Error).message }, 502);
  }
}

export const Route = createFileRoute("/api/public/pluto-import")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "content-type,x-pluto-timestamp,x-pluto-signature",
            "access-control-allow-methods": "POST,OPTIONS",
          },
        }),
    },
  },
});
