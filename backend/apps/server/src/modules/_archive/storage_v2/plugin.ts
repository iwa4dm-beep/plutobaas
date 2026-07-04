// Phase 42 — Storage production plugin.
//
//   POST   /storage/v1/multipart/:bucket/*             → initiate (returns upload_id)
//   PUT    /storage/v1/multipart/:bucket/*?upload_id=&part=  → upload a part
//   POST   /storage/v1/multipart/:bucket/*/complete    → assemble object
//   DELETE /storage/v1/multipart/:bucket/*/abort       → drop staging
//
//   POST /storage/v1/presigned-post                    → mint signed policy
//   POST /storage/v1/presigned-post/upload             → browser direct upload
//
//   GET  /storage/v1/scan/:bucket/*                    → verdict lookup
//   POST /storage/v1/cdn/purge                         → purge one or many URLs
//   GET  /storage/v1/render/imgproxy/:bucket/*         → 302 to signed imgproxy URL
//
// Enable with PLUTO_ENABLE_STORAGE_V2=1. ClamAV/imgproxy each opt in with
// their own env pairs and degrade gracefully when unset.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { pgraw } from "../../../lib/pgraw.js";
import { requireApiKey } from "../../../lib/apikey.js";
import { storage } from "../../../lib/storage.js";
import { env } from "../../../config.js";
import { scanBytes, clamavEnabled } from "../../../lib/clamav.js";
import { imgproxyEnabled, signImgproxyUrl } from "../../../lib/imgproxy.js";
import { log } from "../../../lib/logs.js";

const enabled = process.env.PLUTO_ENABLE_STORAGE_V2 === "1";
const IDENT = /^[a-zA-Z0-9_-]+$/;
const KEY_RX = /^(?!\/)(?!.*\/\.\.?(?:\/|$))[A-Za-z0-9._\-\/]{1,512}$/;
const PART_PREFIX = ".multipart";

function bad(reply: FastifyReply, code: number, error: string, extra?: object) {
  return reply.code(code).send({ error, ...(extra ?? {}) });
}
function md5hex(b: Buffer | Uint8Array) { return createHash("md5").update(b).digest("hex"); }

async function readBody(req: FastifyRequest): Promise<Buffer> {
  const raw = req.raw as unknown as Readable;
  const chunks: Buffer[] = [];
  for await (const c of raw) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
async function readStorage(bucket: string, key: string): Promise<Buffer> {
  const s = await storage.get(bucket, key);
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function policySignature(payload: object): { hash: string; signed: string } {
  const canon = JSON.stringify(payload);
  const hash = createHmac("sha256", env.JWT_SECRET).update(canon).digest("hex");
  return { hash, signed: Buffer.from(canon).toString("base64url") };
}
function verifyPolicy(signed: string, providedHash: string): object | null {
  try {
    const canon = Buffer.from(signed, "base64url").toString("utf-8");
    const expected = createHmac("sha256", env.JWT_SECRET).update(canon).digest("hex");
    const a = Buffer.from(providedHash);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return JSON.parse(canon);
  } catch { return null; }
}

async function enqueueScan(bucket: string, key: string, size: number, contentType?: string) {
  if (!clamavEnabled()) return;
  try {
    await pgraw(
      `insert into public.storage_scan_queue(bucket_name, object_key, size, content_type)
       values ($1,$2,$3,$4)
       on conflict (bucket_name, object_key) do update
         set size = excluded.size, status='pending', attempts=0, enqueued_at=now()`,
      [bucket, key, size, contentType ?? null],
    );
  } catch (e) { /* best-effort */ void e; }
}

export async function storageV2Plugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);

  // =====================================================================
  // Multipart uploads
  // =====================================================================
  app.post("/storage/v1/multipart/:bucket/*", async (req, reply) => {
    const { bucket } = req.params as { bucket: string };
    const key = (req.params as { "*": string })["*"];
    if (!IDENT.test(bucket) || !KEY_RX.test(key)) return bad(reply, 400, "invalid_bucket_or_key");
    const ct = (req.headers["content-type"] as string | undefined) ?? "application/octet-stream";
    const uid = req.auth?.user?.sub ?? null;
    const r = await pgraw<{ id: string }>(
      `insert into public.storage_multipart_uploads (bucket_name, object_key, content_type, created_by)
       values ($1,$2,$3,$4) returning id`,
      [bucket, key, ct, uid],
    );
    await log("storage", "info", `multipart init ${bucket}/${key} id=${r.rows[0].id}`, uid);
    return { upload_id: r.rows[0].id, bucket, key, min_part_size: 5 * 1024 * 1024 };
  });

  app.put("/storage/v1/multipart/:bucket/*", async (req, reply) => {
    const { bucket } = req.params as { bucket: string };
    const key = (req.params as { "*": string })["*"];
    const q = z.object({ upload_id: z.string().uuid(), part: z.coerce.number().int().min(1).max(10_000) })
      .safeParse(req.query);
    if (!q.success) return bad(reply, 400, "invalid_query");

    const up = await pgraw<{ id: string; bucket_name: string; object_key: string; completed_at: Date | null; aborted_at: Date | null }>(
      `select id, bucket_name, object_key, completed_at, aborted_at
         from public.storage_multipart_uploads where id=$1`, [q.data.upload_id]);
    if (up.rows.length === 0) return bad(reply, 404, "upload_not_found");
    const row = up.rows[0];
    if (row.completed_at || row.aborted_at)     return bad(reply, 409, "upload_closed");
    if (row.bucket_name !== bucket || row.object_key !== key) return bad(reply, 400, "bucket_key_mismatch");

    const body = await readBody(req);
    const etag = md5hex(body);
    await storage.put(bucket, `${PART_PREFIX}/${q.data.upload_id}/${q.data.part}`, body,
      "application/octet-stream");
    await pgraw(
      `insert into public.storage_multipart_parts (upload_id, part_number, size, etag)
       values ($1,$2,$3,$4)
       on conflict (upload_id, part_number) do update set size=excluded.size, etag=excluded.etag, uploaded_at=now()`,
      [q.data.upload_id, q.data.part, body.byteLength, etag]);
    return { etag, part: q.data.part, size: body.byteLength };
  });

  app.post("/storage/v1/multipart/:bucket/*/complete", async (req, reply) => {
    const { bucket } = req.params as { bucket: string };
    const key = (req.params as { "*": string })["*"].replace(/\/complete$/, "");
    const body = z.object({
      upload_id: z.string().uuid(),
      parts: z.array(z.object({ part: z.number().int(), etag: z.string() })).min(1),
    }).safeParse(req.body);
    if (!body.success) return bad(reply, 400, "invalid_body");

    const parts = await pgraw<{ part_number: number; size: number; etag: string }>(
      `select part_number, size, etag from public.storage_multipart_parts
        where upload_id=$1 order by part_number asc`, [body.data.upload_id]);
    if (parts.rows.length === 0) return bad(reply, 400, "no_parts");
    // etag verification
    const byNum = new Map(parts.rows.map(p => [p.part_number, p.etag]));
    for (const p of body.data.parts) {
      if (byNum.get(p.part) !== p.etag) return bad(reply, 409, "etag_mismatch", { part: p.part });
    }

    // Assemble by streaming each part into the final object.
    const buffers: Buffer[] = [];
    for (const p of parts.rows) {
      const partKey = `${PART_PREFIX}/${body.data.upload_id}/${p.part_number}`;
      const b = await readStorage(bucket, partKey);
      buffers.push(b);
    }
    const finalBuf = Buffer.concat(buffers);
    const ct = (req.headers["content-type"] as string) ?? "application/octet-stream";
    await storage.put(bucket, key, finalBuf, ct);

    // Cleanup staging.
    for (const p of parts.rows) {
      try { await storage.remove(bucket, `${PART_PREFIX}/${body.data.upload_id}/${p.part_number}`); } catch { /* ignore */ }
    }
    await pgraw(`update public.storage_multipart_uploads set completed_at=now() where id=$1`, [body.data.upload_id]);
    await enqueueScan(bucket, key, finalBuf.byteLength, ct);
    const etag = md5hex(finalBuf);
    return { ok: true, bucket, key, size: finalBuf.byteLength, etag };
  });

  app.delete("/storage/v1/multipart/:bucket/*/abort", async (req, reply) => {
    const q = z.object({ upload_id: z.string().uuid() }).safeParse(req.query);
    if (!q.success) return bad(reply, 400, "invalid_query");
    const parts = await pgraw<{ part_number: number }>(
      `select part_number from public.storage_multipart_parts where upload_id=$1`, [q.data.upload_id]);
    const { bucket } = req.params as { bucket: string };
    for (const p of parts.rows) {
      try { await storage.remove(bucket, `${PART_PREFIX}/${q.data.upload_id}/${p.part_number}`); } catch { /* ignore */ }
    }
    await pgraw(`update public.storage_multipart_uploads set aborted_at=now() where id=$1`, [q.data.upload_id]);
    return { ok: true };
  });

  // =====================================================================
  // Presigned POST
  // =====================================================================
  app.post("/storage/v1/presigned-post", async (req, reply) => {
    const body = z.object({
      bucket: z.string().regex(IDENT),
      key_prefix: z.string().min(1).max(200),
      max_size: z.number().int().min(1).max(5 * 1024 * 1024 * 1024).default(10 * 1024 * 1024),
      content_types: z.array(z.string()).default([]),
      expires_in_sec: z.number().int().min(30).max(3600).default(300),
    }).safeParse(req.body);
    if (!body.success) return bad(reply, 400, "invalid_body");

    const payload = {
      b: body.data.bucket, p: body.data.key_prefix,
      m: body.data.max_size, c: body.data.content_types,
      exp: Math.floor(Date.now() / 1000) + body.data.expires_in_sec,
      n: randomBytes(6).toString("hex"),
    };
    const { hash, signed } = policySignature(payload);
    await pgraw(
      `insert into public.storage_presigned_posts
         (bucket_name, key_prefix, max_size, content_types, expires_at, policy_hash, created_by)
       values ($1,$2,$3,$4,to_timestamp($5),$6,$7)`,
      [payload.b, payload.p, payload.m, payload.c, payload.exp, hash, req.auth?.user?.sub ?? null],
    );
    return {
      url: "/storage/v1/presigned-post/upload",
      fields: { policy: signed, signature: hash, key_prefix: payload.p, bucket: payload.b },
      expires_at: payload.exp,
      max_size: payload.m,
      content_types: payload.c,
    };
  });

  app.post("/storage/v1/presigned-post/upload", async (req, reply) => {
    // Multipart form: fields (policy, signature, filename, content_type) + body
    const body = await readBody(req);
    const policy = (req.headers["x-pluto-policy"] as string | undefined);
    const signature = (req.headers["x-pluto-signature"] as string | undefined);
    const filename = (req.headers["x-pluto-filename"] as string | undefined);
    const contentType = (req.headers["content-type"] as string) ?? "application/octet-stream";
    if (!policy || !signature || !filename) return bad(reply, 400, "missing_headers");

    const parsed = verifyPolicy(policy, signature) as null | {
      b: string; p: string; m: number; c: string[]; exp: number;
    };
    if (!parsed) return bad(reply, 401, "invalid_signature");
    if (parsed.exp < Math.floor(Date.now() / 1000)) return bad(reply, 410, "policy_expired");
    if (body.byteLength > parsed.m) return bad(reply, 413, "too_large", { max: parsed.m });
    if (parsed.c.length && !parsed.c.includes(contentType)) return bad(reply, 415, "unsupported_content_type");

    const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
    const objectKey = `${parsed.p.replace(/\/$/, "")}/${Date.now()}-${safeName}`;
    if (!KEY_RX.test(objectKey)) return bad(reply, 400, "invalid_key");
    await storage.put(parsed.b, objectKey, body, contentType);
    await pgraw(
      `update public.storage_presigned_posts
          set consumed_at=now(), created_object_key=$2
        where policy_hash=$1 and consumed_at is null`,
      [signature, objectKey],
    );
    await enqueueScan(parsed.b, objectKey, body.byteLength, contentType);
    return { ok: true, bucket: parsed.b, key: objectKey, size: body.byteLength };
  });

  // =====================================================================
  // AV scan lookup + on-demand scan
  // =====================================================================
  app.get("/storage/v1/scan/:bucket/*", async (req, reply) => {
    const { bucket } = req.params as { bucket: string };
    const key = (req.params as { "*": string })["*"];
    const r = await pgraw<{ status: string; verdict: string | null; scanner: string | null; scanned_at: Date | null }>(
      `select status, verdict, scanner, scanned_at
         from public.storage_scan_queue where bucket_name=$1 and object_key=$2`, [bucket, key]);
    if (r.rows.length === 0) return { status: "unknown" };
    return r.rows[0];
  });

  app.post("/storage/v1/scan/:bucket/*", async (req, reply) => {
    const { bucket } = req.params as { bucket: string };
    const key = (req.params as { "*": string })["*"];
    if (!clamavEnabled()) return bad(reply, 501, "clamav_disabled");
    try {
      const bytes = await readStorage(bucket, key);
      const started = Date.now();
      await pgraw(`update public.storage_scan_queue set status='scanning', attempts=attempts+1
                    where bucket_name=$1 and object_key=$2`, [bucket, key]);
      const res = await scanBytes(bytes);
      await pgraw(
        `insert into public.storage_scan_queue(bucket_name, object_key, status, verdict, scanner, scanned_at)
         values ($1,$2,$3,$4,$5,now())
         on conflict (bucket_name, object_key) do update
           set status=excluded.status, verdict=excluded.verdict,
               scanner=excluded.scanner, scanned_at=now(),
               error=null`,
        [bucket, key,
         res.verdict === "clean" ? "clean" : res.verdict === "infected" ? "infected" : "error",
         res.signature ?? null, res.scanner]);
      return { ...res, duration_ms: Date.now() - started };
    } catch (e) {
      return bad(reply, 500, "scan_failed", { message: (e as Error).message });
    }
  });

  // =====================================================================
  // CDN cache purge
  // =====================================================================
  app.post("/storage/v1/cdn/purge", async (req, reply) => {
    const body = z.object({
      targets: z.array(z.string().url()).min(1).max(100),
    }).safeParse(req.body);
    if (!body.success) return bad(reply, 400, "invalid_body");

    const provider = process.env.PLUTO_CDN_PROVIDER ?? "generic";
    const results: Array<{ target: string; ok: boolean; status: number }> = [];
    for (const target of body.data.targets) {
      let ok = false, status = 0, respTxt = "";
      try {
        if (provider === "cloudflare" && process.env.PLUTO_CLOUDFLARE_ZONE && process.env.PLUTO_CLOUDFLARE_TOKEN) {
          const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.PLUTO_CLOUDFLARE_ZONE}/purge_cache`, {
            method: "POST",
            headers: { authorization: `Bearer ${process.env.PLUTO_CLOUDFLARE_TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ files: [target] }),
          });
          ok = r.ok; status = r.status; respTxt = await r.text().catch(() => "");
        } else if (provider === "fastly" && process.env.PLUTO_FASTLY_TOKEN) {
          const r = await fetch(target, { method: "PURGE", headers: { "fastly-key": process.env.PLUTO_FASTLY_TOKEN } });
          ok = r.ok; status = r.status; respTxt = await r.text().catch(() => "");
        } else {
          // Generic PURGE for varnish-style caches; treat as best-effort.
          const r = await fetch(target, { method: "PURGE" }).catch(() => null);
          ok = !!r?.ok; status = r?.status ?? 0;
        }
      } catch (e) { respTxt = (e as Error).message; }
      await pgraw(
        `insert into public.storage_cdn_purges(provider, target, ok, status, response, requested_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [provider, target, ok, status, respTxt.slice(0, 4000), req.auth?.user?.sub ?? null]);
      results.push({ target, ok, status });
    }
    return { provider, results };
  });

  // =====================================================================
  // imgproxy signed redirect
  // =====================================================================
  app.get("/storage/v1/render/imgproxy/:bucket/*", async (req, reply) => {
    if (!imgproxyEnabled()) return bad(reply, 501, "imgproxy_disabled");
    const { bucket } = req.params as { bucket: string };
    const key = (req.params as { "*": string })["*"];
    const q = (req.query ?? {}) as Record<string, string>;
    const source = `${process.env.PLUTO_IMGPROXY_SOURCE_BASE?.replace(/\/$/, "") ?? ""}/${bucket}/${key}`;
    const signed = signImgproxyUrl(source, {
      width: q.width ? Number(q.width) : undefined,
      height: q.height ? Number(q.height) : undefined,
      resize: (q.resize as "cover" | "contain" | "fill" | undefined),
      quality: q.quality ? Number(q.quality) : undefined,
      format: (q.format as "webp" | "jpeg" | "png" | "avif" | "original" | undefined),
    });
    if (!signed) return bad(reply, 500, "sign_failed");
    return reply.redirect(signed);
  });
}
