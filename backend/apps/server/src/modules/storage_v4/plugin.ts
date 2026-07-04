// Phase 54 — Storage v4 plugin.
// Endpoints under /storage/v4:
//   POST   /storage/v4/objects           — upload new version (base64 body)
//   GET    /storage/v4/objects/:bucket/:key/versions
//   GET    /storage/v4/objects/:bucket/:key/versions/:version_id
//   DELETE /storage/v4/objects/:bucket/:key/versions/:version_id
//   POST   /storage/v4/retention          — set/extend a retention lock
//   POST   /storage/v4/retention/legal-hold/clear
//   POST   /storage/v4/replication/submit — schedule a cross-region copy
//   POST   /storage/v4/replication/run    — drive one attempt (with backoff)
//   GET    /storage/v4/replication/status?bucket=&object_key=&version_id=
//
// Enabled via PLUTO_ENABLE_STORAGE_V4=1.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey } from "../../lib/apikey.js";
import { putVersion, markDelete, listVersions, getVersion, deleteVersion, sha256Hex } from "../../lib/object-versions.js";
import { setLock, getLock, clearLegalHold, canModify } from "../../lib/retention.js";
import { submit, runOnce, statusFor, listJobs } from "../../lib/replication.js";

const enabled = process.env.PLUTO_ENABLE_STORAGE_V4 === "1";
const BUCKET = /^[a-z0-9][a-z0-9\-]{1,62}$/;
const KEY = /^[A-Za-z0-9!_.*'()\-\/]{1,1024}$/;
const REGION = /^[a-z]{2}-[a-z]+(?:-\d+)?$/;

export async function storageV4Plugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);
  app.log.info({ module: "storage_v4", phase: 54 }, "storage_v4 registered");

  // ---- versioning --------------------------------------------------------
  app.post("/storage/v4/objects", async (req, reply) => {
    const p = z.object({
      bucket: z.string().regex(BUCKET),
      object_key: z.string().regex(KEY),
      body_base64: z.string().min(1),
      content_type: z.string().max(255).optional(),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const bytes = new Uint8Array(Buffer.from(p.data.body_base64, "base64"));
    if (bytes.byteLength > 100 * 1024 * 1024) { reply.code(413); return { error: "too_large" }; }
    const v = putVersion(p.data.bucket, p.data.object_key, bytes, p.data.content_type ?? null);
    return { ok: true, version: v };
  });

  app.get("/storage/v4/objects/:bucket/:key/versions", async (req, reply) => {
    const p = z.object({ bucket: z.string().regex(BUCKET), key: z.string() }).safeParse(req.params);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    return { versions: listVersions(p.data.bucket, decodeURIComponent(p.data.key)) };
  });

  app.get("/storage/v4/objects/:bucket/:key/versions/:version_id", async (req, reply) => {
    const { bucket, key, version_id } = req.params as { bucket: string; key: string; version_id: string };
    const v = getVersion(bucket, decodeURIComponent(key), version_id);
    if (!v) { reply.code(404); return { error: "not_found" }; }
    return v;
  });

  app.delete("/storage/v4/objects/:bucket/:key/versions/:version_id", async (req, reply) => {
    const { bucket, key, version_id } = req.params as { bucket: string; key: string; version_id: string };
    const bypass = (req.headers["x-retention-bypass"] as string) === "governance";
    if (!canModify(bucket, decodeURIComponent(key), version_id, { bypass_governance: bypass })) {
      reply.code(409); return { error: "retention_locked" };
    }
    const removed = deleteVersion(bucket, decodeURIComponent(key), version_id);
    if (!removed) { reply.code(404); return { error: "not_found" }; }
    // Also add a delete marker so history stays visible.
    markDelete(bucket, decodeURIComponent(key));
    return { ok: true };
  });

  // ---- retention ---------------------------------------------------------
  app.post("/storage/v4/retention", async (req, reply) => {
    const p = z.object({
      bucket: z.string().regex(BUCKET),
      object_key: z.string().regex(KEY),
      version_id: z.string(),
      mode: z.enum(["governance", "compliance"]),
      retain_until: z.string().datetime(),
      legal_hold: z.boolean().default(false),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    try {
      const l = setLock(p.data.bucket, p.data.object_key, p.data.version_id, {
        mode: p.data.mode,
        retain_until: new Date(p.data.retain_until).getTime(),
        legal_hold: p.data.legal_hold,
      });
      return { ok: true, lock: l };
    } catch (e) {
      reply.code(409); return { error: (e as Error).message };
    }
  });

  app.post("/storage/v4/retention/legal-hold/clear", async (req, reply) => {
    const p = z.object({ bucket: z.string(), object_key: z.string(), version_id: z.string() }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    const ok = clearLegalHold(p.data.bucket, p.data.object_key, p.data.version_id);
    if (!ok) { reply.code(404); return { error: "not_found" }; }
    return { ok: true, lock: getLock(p.data.bucket, p.data.object_key, p.data.version_id) };
  });

  // ---- replication -------------------------------------------------------
  app.post("/storage/v4/replication/submit", async (req, reply) => {
    const p = z.object({
      bucket: z.string().regex(BUCKET),
      object_key: z.string().regex(KEY),
      version_id: z.string(),
      source_region: z.string().regex(REGION),
      target_region: z.string().regex(REGION),
      idempotency_key: z.string().min(4).max(200),
    }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request", issues: p.error.issues }; }
    if (p.data.source_region === p.data.target_region) { reply.code(400); return { error: "same_region" }; }
    const job = submit(p.data);
    return { ok: true, job };
  });

  app.post("/storage/v4/replication/run", async (req, reply) => {
    const p = z.object({ job_id: z.string() }).safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    const job = listJobs().find((j) => j.id === p.data.job_id);
    if (!job) { reply.code(404); return { error: "job_not_found" }; }
    const v = getVersion(job.bucket, job.object_key, job.version_id);
    if (!v) { reply.code(404); return { error: "version_not_found" }; }
    const result = await runOnce(job.id, async () => ({ ok: true, remote_checksum: v.checksum_sha256 }), v.checksum_sha256, v.created_at);
    return { ok: true, job: result };
  });

  app.get("/storage/v4/replication/status", async (req, reply) => {
    const p = z.object({
      bucket: z.string(), object_key: z.string(), version_id: z.string(),
    }).safeParse(req.query);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    return { jobs: statusFor(p.data.bucket, p.data.object_key, p.data.version_id) };
  });



  // Streaming SSE — emits a snapshot every 250 ms until all jobs for the
  // given (bucket, object_key, version_id) reach a terminal state, or up to
  // `max_events` frames. Clients close the stream at any time.
  app.get("/storage/v4/replication/stream", async (req, reply) => {
    const p = z.object({
      bucket: z.string(), object_key: z.string(), version_id: z.string(),
      max_events: z.coerce.number().int().min(1).max(120).optional(),
    }).safeParse(req.query);
    if (!p.success) { reply.code(400); return { error: "bad_request" }; }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-storage-v4-stream": "replication",
    });
    const cap = p.data.max_events ?? 60;
    let sent = 0;
    const terminal = new Set(["succeeded", "failed", "skipped"]);
    while (sent < cap) {
      const jobs = statusFor(p.data.bucket, p.data.object_key, p.data.version_id);
      reply.raw.write(`data: ${JSON.stringify({ ts: Date.now(), jobs })}\n\n`);
      sent++;
      if (jobs.length > 0 && jobs.every((j) => terminal.has(j.status))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    reply.raw.end();
  });
}


export { sha256Hex };
export default storageV4Plugin;

