// Phase 47 — Observability v2 (OTel traces, RED metrics, SLOs, log alerts)
// Endpoints (all under /obs/v2):
//   POST /obs/v2/traces                       ingest OTLP-shaped spans (batch)
//   GET  /obs/v2/traces/:traceId              fetch a trace tree
//   GET  /obs/v2/metrics                      Prometheus RED exposition
//   GET  /obs/v2/red                          JSON snapshot of RED metrics
//   POST /obs/v2/slos                         create SLO
//   GET  /obs/v2/slos                         list SLOs
//   POST /obs/v2/slos/:id/evaluate            evaluate burn-rate windows
//   GET  /obs/v2/slos/:id/burn                recent burn events
//   POST /obs/v2/log-alerts                   create log-based alert rule
//   GET  /obs/v2/log-alerts                   list log alert rules
//   POST /obs/v2/log-alerts/tick              evaluate rules; fire webhooks
//   GET  /obs/v2/logs                         recent structured logs (ring)
//
// Enable with PLUTO_ENABLE_OBSERVABILITY_V2=1. Optional OTLP export via
// PLUTO_OTLP_ENDPOINT (e.g. http://collector:4318). All endpoints require
// an API key; mutating endpoints require service_role / admin.

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { q } from "../../../lib/pgraw.js";
import { requireApiKey, requireAdmin } from "../../../lib/apikey.js";
import {
  newTraceId, newSpanId, parseTraceparent, formatTraceparent,
  toOtlpPayload, exportOtlp, type OtelSpan,
} from "../../../lib/otel.js";
import { recordRequest, toPrometheus, snapshot as redSnapshot } from "../../../lib/red-metrics.js";
import { BURN_WINDOWS, burnRate, type SloRow } from "../../../lib/slo.js";
import { evaluateErrorRatio } from "../../../lib/slo-eval.js";
import { pushLog, recentLogs, matchesRule, type LogAlertRule } from "../../../lib/log-buffer.js";

const spanIngest = z.object({
  spans: z.array(z.object({
    trace_id: z.string().regex(/^[0-9a-f]{32}$/i),
    span_id:  z.string().regex(/^[0-9a-f]{16}$/i),
    parent_id: z.string().regex(/^[0-9a-f]{16}$/i).nullable().optional(),
    name: z.string().min(1).max(200),
    kind: z.enum(["internal","server","client","producer","consumer"]).default("server"),
    service: z.string().max(80).default("pluto-api"),
    status_code: z.number().int().min(0).max(2).default(0),
    attributes: z.record(z.unknown()).default({}),
    events: z.array(z.object({
      name: z.string(), time: z.number(), attributes: z.record(z.unknown()).optional(),
    })).default([]),
    started_at: z.number().int(),
    ended_at:   z.number().int().optional(),
  })).min(1).max(500),
});

const sloBody = z.object({
  slug: z.string().min(1).max(80),
  service: z.string().default("pluto-api"),
  route_pattern: z.string().default(".*"),
  kind: z.enum(["availability","latency"]),
  objective: z.number().gt(0).lt(1),
  threshold_ms: z.number().int().positive().optional(),
  window_days: z.number().int().positive().max(90).default(30),
});

const logAlertBody = z.object({
  slug: z.string().min(1).max(80),
  level: z.enum(["info","warn","error","fatal"]).default("error"),
  contains: z.string().max(500).optional(),
  route_regex: z.string().max(200).optional(),
  threshold: z.number().int().positive().default(10),
  window_secs: z.number().int().positive().max(3600).default(300),
  webhook_url: z.string().url().optional(),
  enabled: z.boolean().default(true),
});

export const observabilityV2Plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (process.env.PLUTO_ENABLE_OBSERVABILITY_V2 !== "1") {
    app.log.info({ module: "observability_v2" }, "observability_v2 disabled (set PLUTO_ENABLE_OBSERVABILITY_V2=1)");
    return;
  }
  app.log.info({ module: "observability_v2", phase: "47" }, "observability_v2 registered");

  // ----- Auto trace + RED metric per request ---------------------------
  app.decorateRequest("otelCtx", null as null | { traceId: string; spanId: string; startedAt: number; sampled: boolean });
  app.addHook("onRequest", async (req, reply) => {
    const tp = parseTraceparent(req.headers["traceparent"] as string | undefined);
    const traceId = tp?.traceId ?? newTraceId();
    const spanId  = newSpanId();
    const sampled = tp?.sampled ?? true;
    (req as unknown as { otelCtx: { traceId: string; spanId: string; startedAt: number; sampled: boolean } })
      .otelCtx = { traceId, spanId, startedAt: Date.now(), sampled };
    reply.header("traceparent", formatTraceparent(traceId, spanId, sampled));
    reply.header("x-trace-id", traceId);
  });

  app.addHook("onResponse", async (req, reply) => {
    const ctx = (req as unknown as { otelCtx: { traceId: string; spanId: string; startedAt: number; sampled: boolean } | null }).otelCtx;
    if (!ctx) return;
    const dur = Date.now() - ctx.startedAt;
    const route = (req.routeOptions?.url ?? req.url.split("?")[0]).slice(0, 120);
    recordRequest(route, req.method, reply.statusCode, dur);

    // Structured log for the log-based alert engine.
    pushLog({
      ts: Date.now(),
      level: reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "warn" : "info",
      route, method: req.method, status: reply.statusCode, trace_id: ctx.traceId,
      msg: `${req.method} ${route} ${reply.statusCode} ${dur}ms`,
    });

    // Persist root span (best-effort, sampled only).
    if (!ctx.sampled) return;
    const status = reply.statusCode >= 500 ? 2 : reply.statusCode >= 400 ? 2 : 1;
    try {
      await q(
        `insert into public.obs_v2_spans
           (trace_id, span_id, parent_id, name, kind, service, status_code,
            attributes, events, started_at, ended_at, duration_ms)
         values ($1,$2,null,$3,'server','pluto-api',$4,$5::jsonb,'[]'::jsonb,
                 to_timestamp($6/1000.0), to_timestamp($7/1000.0), $8)`,
        [
          ctx.traceId, ctx.spanId,
          `${req.method} ${route}`, status,
          JSON.stringify({ "http.method": req.method, "http.route": route, "http.status_code": reply.statusCode }),
          ctx.startedAt, ctx.startedAt + dur, dur,
        ],
      );
    } catch { /* observability must never break the hot path */ }

    // Optional OTLP export
    const endpoint = process.env.PLUTO_OTLP_ENDPOINT;
    if (endpoint) {
      const span: OtelSpan = {
        traceId: ctx.traceId, spanId: ctx.spanId, parentId: null,
        name: `${req.method} ${route}`, kind: "server", service: "pluto-api",
        startedAt: ctx.startedAt, endedAt: ctx.startedAt + dur, status,
        attributes: { "http.method": req.method, "http.route": route, "http.status_code": reply.statusCode },
        events: [],
      };
      void exportOtlp(endpoint, toOtlpPayload([span]));
    }
  });

  // ----- Trace ingest ------------------------------------------------
  app.post("/obs/v2/traces", async (req, reply) => {
    await requireApiKey(req, reply); if (reply.sent) return;
    const parsed = spanIngest.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: "invalid_body", details: parsed.error.flatten() }; }
    for (const s of parsed.data.spans) {
      await q(
        `insert into public.obs_v2_spans
           (trace_id, span_id, parent_id, name, kind, service, status_code,
            attributes, events, started_at, ended_at, duration_ms)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,
                 to_timestamp($10/1000.0),
                 case when $11::bigint is null then null else to_timestamp($11/1000.0) end,
                 case when $11::bigint is null then null else $11::double precision - $10::double precision end)`,
        [
          s.trace_id.toLowerCase(), s.span_id.toLowerCase(), s.parent_id ?? null,
          s.name, s.kind, s.service, s.status_code,
          JSON.stringify(s.attributes), JSON.stringify(s.events),
          s.started_at, s.ended_at ?? null,
        ],
      );
    }
    // Fan out to OTLP collector if configured.
    const endpoint = process.env.PLUTO_OTLP_ENDPOINT;
    if (endpoint) {
      const spans: OtelSpan[] = parsed.data.spans.map((s) => ({
        traceId: s.trace_id, spanId: s.span_id, parentId: s.parent_id ?? null,
        name: s.name, kind: s.kind, service: s.service, status: s.status_code as 0|1|2,
        startedAt: s.started_at, endedAt: s.ended_at,
        attributes: s.attributes, events: s.events,
      }));
      void exportOtlp(endpoint, toOtlpPayload(spans));
    }
    return { ok: true, ingested: parsed.data.spans.length };
  });

  app.get<{ Params: { traceId: string } }>("/obs/v2/traces/:traceId", async (req, reply) => {
    await requireApiKey(req, reply); if (reply.sent) return;
    if (!/^[0-9a-f]{32}$/i.test(req.params.traceId)) { reply.code(400); return { error: "bad_trace_id" }; }
    const rows = await q(
      `select trace_id, span_id, parent_id, name, kind, service, status_code,
              attributes, events, started_at, ended_at, duration_ms
         from public.obs_v2_spans
        where trace_id = $1
        order by started_at asc
        limit 5000`,
      [req.params.traceId.toLowerCase()],
    );
    return { trace_id: req.params.traceId, spans: rows };
  });

  // ----- RED metrics -------------------------------------------------
  app.get("/obs/v2/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return toPrometheus();
  });
  app.get("/obs/v2/red", async (req, reply) => {
    await requireApiKey(req, reply); if (reply.sent) return;
    return redSnapshot();
  });

  // ----- SLO CRUD + evaluation --------------------------------------
  app.post("/obs/v2/slos", async (req, reply) => {
    await requireApiKey(req, reply); if (reply.sent) return;
    requireAdmin(req, reply); if (reply.sent) return;
    const p = sloBody.safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "invalid_body", details: p.error.flatten() }; }
    if (p.data.kind === "latency" && !p.data.threshold_ms) {
      reply.code(400); return { error: "threshold_ms_required_for_latency_slo" };
    }
    const [row] = await q<SloRow>(
      `insert into public.obs_v2_slos
         (slug, service, route_pattern, kind, objective, threshold_ms, window_days)
       values ($1,$2,$3,$4,$5,$6,$7)
       returning id, slug, service, route_pattern, kind, objective, threshold_ms, window_days`,
      [p.data.slug, p.data.service, p.data.route_pattern, p.data.kind,
       p.data.objective, p.data.threshold_ms ?? null, p.data.window_days],
    );
    reply.code(201);
    return { slo: row };
  });

  app.get("/obs/v2/slos", async (req, reply) => {
    await requireApiKey(req, reply); if (reply.sent) return;
    return {
      slos: await q<SloRow>(
        `select id, slug, service, route_pattern, kind, objective, threshold_ms, window_days
           from public.obs_v2_slos order by created_at desc`,
      ),
    };
  });

  app.post<{ Params: { id: string } }>("/obs/v2/slos/:id/evaluate", async (req, reply) => {
    await requireApiKey(req, reply); if (reply.sent) return;
    requireAdmin(req, reply); if (reply.sent) return;
    const rows = await q<SloRow>(
      `select id, slug, service, route_pattern, kind, objective, threshold_ms, window_days
         from public.obs_v2_slos where id = $1`, [req.params.id],
    );
    if (!rows[0]) { reply.code(404); return { error: "slo_not_found" }; }
    const slo = rows[0];
    const results: Array<{ window: string; ratio: number; burn: number; breaching: boolean; total: number }> = [];
    for (const w of BURN_WINDOWS) {
      const { total, ratio } = await evaluateErrorRatio(slo, w.minutes);
      const br = burnRate(ratio, slo.objective);
      const breaching = br >= w.alertBurn && total > 0;
      results.push({ window: w.label, ratio, burn: br, breaching, total });
      await q(
        `insert into public.obs_v2_burn_events (slo_id, window_label, burn_rate, breaching)
         values ($1,$2,$3,$4)`,
        [slo.id, w.label, Number.isFinite(br) ? br : 1e9, breaching],
      );
    }
    return { slo_id: slo.id, evaluated_at: new Date().toISOString(), windows: results };
  });

  app.get<{ Params: { id: string } }>("/obs/v2/slos/:id/burn", async (req, reply) => {
    await requireApiKey(req, reply); if (reply.sent) return;
    return {
      events: await q(
        `select window_label, burn_rate, breaching, evaluated_at
           from public.obs_v2_burn_events
          where slo_id = $1
          order by evaluated_at desc limit 200`,
        [req.params.id],
      ),
    };
  });

  // ----- Log-based alerts -------------------------------------------
  app.post("/obs/v2/log-alerts", async (req, reply) => {
    await requireApiKey(req, reply); if (reply.sent) return;
    requireAdmin(req, reply); if (reply.sent) return;
    const p = logAlertBody.safeParse(req.body);
    if (!p.success) { reply.code(400); return { error: "invalid_body", details: p.error.flatten() }; }
    const [row] = await q<LogAlertRule>(
      `insert into public.obs_v2_log_alerts
         (slug, level, contains, route_regex, threshold, window_secs, webhook_url, enabled)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id, slug, level, contains, route_regex, threshold, window_secs, webhook_url, enabled`,
      [p.data.slug, p.data.level, p.data.contains ?? null, p.data.route_regex ?? null,
       p.data.threshold, p.data.window_secs, p.data.webhook_url ?? null, p.data.enabled],
    );
    reply.code(201);
    return { alert: row };
  });

  app.get("/obs/v2/log-alerts", async (req, reply) => {
    await requireApiKey(req, reply); if (reply.sent) return;
    return {
      alerts: await q<LogAlertRule & { last_fired_at: string | null }>(
        `select id, slug, level, contains, route_regex, threshold, window_secs,
                webhook_url, enabled, last_fired_at
           from public.obs_v2_log_alerts order by created_at desc`,
      ),
    };
  });

  app.post("/obs/v2/log-alerts/tick", async (req, reply) => {
    await requireApiKey(req, reply); if (reply.sent) return;
    requireAdmin(req, reply); if (reply.sent) return;
    const rules = await q<LogAlertRule>(
      `select id, slug, level, contains, route_regex, threshold, window_secs, webhook_url, enabled
         from public.obs_v2_log_alerts where enabled = true`,
    );
    const logs = recentLogs(3600 * 1000);
    const fired: Array<{ slug: string; count: number; delivered: boolean }> = [];
    for (const r of rules) {
      const hits = matchesRule(logs, r);
      if (hits.length < r.threshold) continue;
      let delivered = false;
      if (r.webhook_url) {
        try {
          const res = await fetch(r.webhook_url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              alert: r.slug, level: r.level, count: hits.length,
              window_secs: r.window_secs, sample: hits.slice(-5),
            }),
          });
          delivered = res.ok;
        } catch { delivered = false; }
      }
      await q(`update public.obs_v2_log_alerts set last_fired_at = now() where id = $1`, [r.id]);
      fired.push({ slug: r.slug, count: hits.length, delivered });
    }
    return { evaluated: rules.length, fired };
  });

  app.get("/obs/v2/logs", async (req, reply) => {
    await requireApiKey(req, reply); if (reply.sent) return;
    const url = new URL(req.url, "http://x");
    const mins = Math.min(60, Math.max(1, Number(url.searchParams.get("minutes") ?? 10)));
    return { logs: recentLogs(mins * 60 * 1000) };
  });
};
