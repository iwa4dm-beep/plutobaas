// HMAC-signed control channel for the Pluto Migrator Chrome extension.
//
//   POST /api/public/pluto-import-status
//     headers:
//       x-pluto-timestamp: <unix seconds>
//       x-pluto-signature: sha256=<hex HMAC of `${timestamp}.${rawBody}`>
//     body: { action, ... }
//
// Actions
//   status        { job_id? , event_id?, since? }  → job + timeline events
//   upload_status { upload_id }                    → received chunk indices
//   rollback      { job_id, dry_run? }             → one-click undo
//   prune_uploads { hours? }                       → staging housekeeping
//
// Security: same shared secret as the ingest webhook (admin-grade), timing
// safe comparison, ±5 min replay window. Read actions are cheap; `rollback`
// is a privileged mutation and is fully audited in import_job_events.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Body = z.object({
  action: z.enum(["status", "upload_status", "rollback", "prune_uploads"]),
  job_id: z.string().max(100).optional(),
  event_id: z.string().max(200).optional(),
  upload_id: z.string().max(200).optional(),
  since: z.string().max(64).optional(),
  dry_run: z.boolean().optional(),
  hours: z.number().int().min(1).max(24 * 30).optional(),
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
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

async function handle(request: Request): Promise<Response> {
  const secret = process.env.PLUTO_IMPORT_WEBHOOK_SECRET;
  if (!secret) return json({ ok: false, error: "not_configured" }, 503);

  const raw = await request.text();
  const ts = request.headers.get("x-pluto-timestamp") ?? "";
  const sig = (request.headers.get("x-pluto-signature") ?? "").replace(/^sha256=/i, "");
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return json({ ok: false, error: "stale_or_missing_timestamp" }, 401);
  }
  const expected = await sign(secret, `${ts}.${raw}`);
  if (!sig || !timingSafeEqual(sig.toLowerCase(), expected)) {
    return json({ ok: false, error: "invalid_signature" }, 401);
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(JSON.parse(raw));
  } catch (e) {
    return json({ ok: false, error: "invalid_payload", detail: (e as Error).message }, 400);
  }

  try {
    if (body.action === "upload_status") {
      if (!body.upload_id) return json({ ok: false, error: "upload_id_required" }, 400);
      const { getUploadState } = await import("@/lib/pluto/import-chunks.server");
      const state = await getUploadState(body.upload_id);
      return json({ ok: true, state });
    }

    if (body.action === "prune_uploads") {
      const { pruneUploads } = await import("@/lib/pluto/import-chunks.server");
      return json({ ok: true, removed: await pruneUploads(body.hours ?? 48) });
    }

    const store = await import("@/lib/pluto/import-jobs.server");

    if (body.action === "rollback") {
      if (!body.job_id) return json({ ok: false, error: "job_id_required" }, 400);
      const { runJobRollback } = await import("@/lib/pluto/import-rollback.server");
      const result = await runJobRollback({
        jobId: body.job_id,
        dryRun: body.dry_run === true,
        actorEmail: "chrome-extension",
      });
      return json({ ok: result.ok, result }, result.ok ? 200 : 400);
    }

    // action === "status"
    let job = body.job_id ? await store.getImportJobById(body.job_id) : null;
    if (!job && body.event_id) {
      const jobs = await store.listImportJobs(200);
      job = jobs.find((j) => j.event_id === body.event_id) ?? null;
    }
    if (!job) return json({ ok: false, error: "job_not_found" }, 404);

    const events = await store.listImportEvents(job.id, 200);
    const since = body.since ? Date.parse(body.since) : NaN;
    const fresh = Number.isFinite(since)
      ? events.filter((e) => Date.parse(e.created_at) > since)
      : events;
    const runs = await store.listVerificationRuns(job.id, 3).catch(() => []);

    return json({
      ok: true,
      job: {
        id: job.id,
        event_id: job.event_id,
        status: job.status,
        repo: job.repo,
        paused: job.paused,
        applied_at: job.applied_at,
        applied_by: job.applied_by,
        selection: job.selection,
        sql_chars: job.migration_sql?.length ?? 0,
        created_at: job.created_at,
        updated_at: job.updated_at,
      },
      events: fresh.map((e) => ({
        id: e.id,
        step: e.step,
        ok: e.ok,
        actor_email: e.actor_email,
        row_count: e.row_count,
        duration_ms: e.duration_ms,
        message: e.message,
        created_at: e.created_at,
      })),
      verification: runs.map((r) => ({
        run_no: r.run_no,
        ok: r.ok,
        counts: (r.report as { counts?: unknown })?.counts ?? null,
        created_at: r.created_at,
      })),
      server_time: new Date().toISOString(),
    });
  } catch (e) {
    return json({ ok: false, error: "server_error", detail: (e as Error).message }, 500);
  }
}

export const Route = createFileRoute("/api/public/pluto-import-status")({
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
