// Server-Sent Events stream for a single import job's audit timeline.
//
// Replaces the old 4-second client polling loop: the server watches the job
// row + its event rows and pushes only what changed. Auth is checked from the
// Authorization header, so the client consumes it with fetch + ReadableStream
// (EventSource cannot send headers).
import { createFileRoute } from "@tanstack/react-router";

const POLL_MS = 1500;
const MAX_MS = 10 * 60 * 1000;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const Route = createFileRoute("/api/import-events/$jobId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const auth = request.headers.get("authorization") ?? "";
        if (!/^Bearer\s+\S+/i.test(auth)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const { verifyAdminToken } = await import("@/lib/pluto/admin-middleware");
        try {
          await verifyAdminToken(auth);
        } catch {
          return new Response("Forbidden", { status: 403 });
        }

        const jobId = params.jobId;
        if (!/^[0-9a-f-]{16,64}$/i.test(jobId)) {
          return new Response("Bad job id", { status: 400 });
        }

        const { listImportEvents, getImportJobById } = await import("@/lib/pluto/import-jobs.server");
        const encoder = new TextEncoder();
        const started = Date.now();

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let seen = new Set<string>();
            let lastJobStamp = "";
            let closed = false;
            const push = (event: string, data: unknown) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(sse(event, data)));
              } catch {
                closed = true;
              }
            };

            request.signal?.addEventListener("abort", () => {
              closed = true;
              try { controller.close(); } catch { /* already closed */ }
            });

            while (!closed && Date.now() - started < MAX_MS) {
              try {
                const [job, events] = await Promise.all([
                  getImportJobById(jobId),
                  listImportEvents(jobId, 300),
                ]);
                if (!job) {
                  push("error", { error: "not_found" });
                  break;
                }
                const stamp = `${job.status}|${job.updated_at}|${job.paused}|${job.applied_at ?? ""}`;
                if (stamp !== lastJobStamp) {
                  lastJobStamp = stamp;
                  push("job", {
                    id: job.id,
                    status: job.status,
                    paused: job.paused,
                    paused_by: job.paused_by,
                    paused_at: job.paused_at,
                    resume_step: job.resume_step,
                    applied_at: job.applied_at,
                    applied_by: job.applied_by,
                    selection: job.selection,
                    updated_at: job.updated_at,
                  });
                }
                const fresh = events.filter((e) => !seen.has(e.id));
                if (fresh.length) {
                  for (const e of fresh) seen.add(e.id);
                  // Keep the set bounded on very long-lived streams.
                  if (seen.size > 2000) seen = new Set(events.map((e) => e.id));
                  push("events", fresh.map((e) => ({
                    id: e.id,
                    job_id: e.job_id,
                    step: e.step,
                    ok: e.ok,
                    actor_email: e.actor_email,
                    row_count: e.row_count,
                    duration_ms: e.duration_ms,
                    message: e.message,
                    detail: e.detail ? JSON.stringify(e.detail).slice(0, 8000) : null,
                    created_at: e.created_at,
                  })));
                }
              } catch (err) {
                push("error", { error: err instanceof Error ? err.message : String(err) });
              }
              // Heartbeat keeps proxies from closing an idle connection.
              push("ping", { at: new Date().toISOString() });
              await new Promise((r) => setTimeout(r, POLL_MS));
            }
            try { controller.close(); } catch { /* already closed */ }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
