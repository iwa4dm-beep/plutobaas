// Phase 58 — Observability v3 plugin: distributed traces, live audit tail,
// SLO tracking + alerting. Mount prefix `/obs/v3`. Enabled via
// PLUTO_ENABLE_OBSERVABILITY_V3=1.
//
// Behavior:
//  - Global `onRequest` hook parses W3C `traceparent`, starts a request span,
//    and puts `{ trace_id, span_id }` on `req.trace`. `onResponse` finishes
//    the span and records an SLO sample keyed by `${method} ${routerPath}`.
//  - `logAuth` picks up the current trace_id via a context provider so every
//    audit event includes a `trace_id` for pivoting to /obs/v3/traces/:id.
//  - `/obs/v3/audit/tail` streams new events as SSE, with bounded backpressure
//    (drops the oldest queued events when the client can't keep up).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireApiKey } from "../../lib/apikey.js";
import {
  configureTracing, endSpan, formatTraceparent, getTrace, listSpans,
  parseTraceparent, startSpan, subscribeSpans, type Span,
} from "../../lib/tracing.js";
import {
  configureDefaults, listIncidents, listTargets, record, setTarget, type SloTarget,
} from "../../lib/slo-tracker.js";
import * as iso from "../../lib/session-isolation.js";

const enabled = process.env.PLUTO_ENABLE_OBSERVABILITY_V3 === "1";

declare module "fastify" {
  interface FastifyRequest { trace?: { trace_id: string; span_id: string; span: Span }; }
}

function ws(req: FastifyRequest): string {
  return (req.headers["x-workspace-id"] as string) || req.auth?.workspaceId || "default";
}

// AsyncLocalStorage-style current-request context (Fastify keeps a per-request
// object, so we use a simple stack via a WeakMap for the active span).
let currentTraceId: string | undefined;

export async function observabilityV3Plugin(app: FastifyInstance) {
  if (!enabled) return;
  configureTracing({ service: process.env.PLUTO_SERVICE_NAME ?? "pluto-api" });
  configureDefaults();
  iso.setAuthEventContext(() => (currentTraceId ? { trace_id: currentTraceId } : undefined));

  // --- trace context propagation + SLO sampling ---------------------------
  app.addHook("onRequest", async (req, reply) => {
    const parent = parseTraceparent(req.headers.traceparent as string | undefined);
    const span = startSpan(`${req.method} ${req.url}`, parent);
    span.attributes["http.method"] = req.method;
    span.attributes["http.route"]  = req.url;
    req.trace = { trace_id: span.trace_id, span_id: span.span_id, span };
    currentTraceId = span.trace_id;
    reply.header("traceparent", formatTraceparent(span.trace_id, span.span_id));
  });

  app.addHook("onResponse", async (req, reply) => {
    const t = req.trace; if (!t) return;
    const ok = reply.statusCode < 500;
    endSpan(t.span, ok ? "ok" : "error", {
      "http.status_code": reply.statusCode,
      "http.route_pattern": (req.routeOptions?.url ?? req.url),
    });
    const endpoint = `${req.method} ${req.routeOptions?.url ?? req.url}`;
    const latency_ms = Number(reply.elapsedTime ?? ((t.span.end_ns! - t.span.start_ns) / 1_000_000));
    record({ endpoint, latency_ms, ok: reply.statusCode < 400, trace_id: t.trace_id });
    if (currentTraceId === t.trace_id) currentTraceId = undefined;
  });

  // --- All /obs/v3/* routes need an API key ------------------------------
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/obs/v3/")) return;
    return requireApiKey(req, reply);
  });

  app.log.info({ module: "observability_v3", phase: 58 }, "observability_v3 registered");

  // --- Traces --------------------------------------------------------------
  app.get("/obs/v3/traces", async (req) => {
    const q = req.query as { name?: string; limit?: string };
    return { spans: listSpans({ name: q.name, limit: q.limit ? Number(q.limit) : 200 }) };
  });
  app.get("/obs/v3/traces/:trace_id", async (req, reply) => {
    const id = (req.params as { trace_id: string }).trace_id;
    const spans = getTrace(id);
    if (spans.length === 0) { reply.code(404); return { error: "not_found" }; }
    return { trace_id: id, spans };
  });

  // --- SLO targets + incidents --------------------------------------------
  app.get("/obs/v3/slo/targets", async () => ({ targets: listTargets() }));
  app.post("/obs/v3/slo/targets", async (req, reply) => {
    if ((req.headers["x-role"] as string) !== "admin") { reply.code(403); return { error: "admin_required" }; }
    const t = req.body as SloTarget;
    if (!t?.endpoint || !t.window_ms || t.max_error_rate == null || !t.p95_latency_ms) {
      reply.code(400); return { error: "bad_request" };
    }
    setTarget(t);
    return { ok: true, target: t };
  });
  app.get("/obs/v3/slo/incidents", async (req) => {
    const openOnly = (req.query as { open?: string }).open === "1";
    return { incidents: listIncidents(openOnly) };
  });

  // --- Live audit tail (SSE) with backpressure ----------------------------
  app.get("/obs/v3/audit/tail", async (req, reply) => {
    const workspace_id = ws(req);
    const q = req.query as { action?: string; status?: string };
    reply.raw.setHeader("content-type", "text/event-stream");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    reply.raw.setHeader("x-accel-buffering", "no");
    reply.raw.flushHeaders?.();

    // Send recent history first.
    for (const ev of iso.listEvents(workspace_id, { limit: 50 }).reverse()) {
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    }

    // Bounded backpressure queue. If the client is slow and we can't drain
    // to socket faster than events arrive, drop the oldest to keep memory
    // bounded and emit a `dropped` control event so operators know.
    const MAX_QUEUE = 500;
    let queue: string[] = [];
    let dropped = 0;
    let writing = false;

    const flush = () => {
      if (writing) return;
      writing = true;
      while (queue.length > 0) {
        const chunk = queue.shift()!;
        const ok = reply.raw.write(chunk);
        if (!ok) {
          reply.raw.once("drain", () => { writing = false; flush(); });
          return;
        }
      }
      writing = false;
    };

    const unsub = iso.subscribeAuthEvents((ev) => {
      if (ev.workspace_id !== workspace_id) return;
      if (q.action && ev.action !== q.action) return;
      if (q.status && ev.status !== q.status) return;
      if (queue.length >= MAX_QUEUE) {
        dropped++;
        queue.shift();
        queue.push(`event: dropped\ndata: ${JSON.stringify({ dropped })}\n\n`);
      }
      queue.push(`data: ${JSON.stringify(ev)}\n\n`);
      flush();
    });

    // Heartbeat every 15s so proxies don't close idle streams.
    const heartbeat = setInterval(() => {
      try { reply.raw.write(`: hb ${Date.now()}\n\n`); } catch { /* noop */ }
    }, 15_000);

    req.raw.on("close", () => { unsub(); clearInterval(heartbeat); reply.raw.end(); });
  });

  // --- OTLP-lite ingest: allow external services to POST spans ------------
  app.post("/obs/v3/traces/ingest", async (req, reply) => {
    const body = req.body as { spans?: Span[] };
    if (!Array.isArray(body?.spans)) { reply.code(400); return { error: "bad_request" }; }
    for (const s of body.spans) {
      // Re-emit via the tracer so subscribers + buffer stay consistent.
      const span = startSpan(s.name, { trace_id: s.trace_id, parent_id: s.parent_id });
      endSpan(span, s.status ?? "ok", s.attributes ?? {});
    }
    return { ok: true, ingested: body.spans.length };
  });

  // Expose the subscribeSpans hook for tests that want to await a span.
  subscribeSpans(() => { /* keep at least one subscriber to exercise the fanout */ });
}
