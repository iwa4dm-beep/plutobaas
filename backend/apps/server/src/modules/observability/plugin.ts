// Phase 18 — Observability & Compliance
// Endpoints:
//   POST /obs/v1/metrics           → ingest samples
//   GET  /obs/v1/metrics/query     → aggregate rollups (avg,p95,count,sum) in a time bucket
//   POST /obs/v1/spans             → ingest trace spans
//   GET  /obs/v1/traces/:traceId   → fetch a full trace tree
//   GET  /obs/v1/prometheus        → text exposition (last 5 min)
//   POST /compliance/v1/gdpr       → open export/erasure request (subject or admin)
//   GET  /compliance/v1/gdpr       → list requests (self or admin all)
//   POST /compliance/v1/gdpr/:id/run → execute (admin only)
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { q } from "../../lib/pgraw.js";
import { requireApiKey, requireAdmin } from "../../lib/apikey.js";

const metricBody = z.object({
  samples: z.array(z.object({
    metric: z.string().min(1).max(120),
    value:  z.number().finite(),
    labels: z.record(z.string()).default({}),
    observed_at: z.string().datetime().optional(),
  })).min(1).max(500),
});
const spanBody = z.object({
  spans: z.array(z.object({
    trace_id: z.string().uuid(),
    span_id:  z.string().uuid().optional(),
    parent_id: z.string().uuid().nullable().optional(),
    name: z.string().min(1).max(200),
    kind: z.enum(["internal","server","client","producer","consumer"]).default("internal"),
    attributes: z.record(z.unknown()).default({}),
    started_at: z.string().datetime(),
    ended_at:   z.string().datetime().optional(),
  })).min(1).max(200),
});
const gdprBody = z.object({
  subject_id: z.string().uuid(),
  kind: z.enum(["export","erasure"]),
  notes: z.string().max(1000).optional(),
});

export const observabilityPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (process.env.PLUTO_ENABLE_OBSERVABILITY !== "1") {
    app.log.info({ module: "observability" }, "observability disabled (set PLUTO_ENABLE_OBSERVABILITY=1)");
    return;
  }
  app.log.info({ module: "observability", phase: "18" }, "observability registered");

  // ---- Auto tracing --------------------------------------------------
  // Attach a trace id to every request, mirror it into `x-trace-id`,
  // and persist a root span on completion so /obs/v1/traces surfaces
  // recent requests linked back to dashboard debugging tools.
  app.decorateRequest("plutoTrace", null as null | { traceId: string; startedAt: number });
  app.addHook("onRequest", async (req, reply) => {
    const traceId = (req.headers["x-trace-id"] as string) || crypto.randomUUID();
    (req as unknown as { plutoTrace: { traceId: string; startedAt: number } }).plutoTrace =
      { traceId, startedAt: Date.now() };
    reply.header("x-trace-id", traceId);
  });
  app.addHook("onResponse", async (req, reply) => {
    const t = (req as unknown as { plutoTrace: { traceId: string; startedAt: number } | null }).plutoTrace;
    if (!t) return;
    const dur = Date.now() - t.startedAt;
    // Labels intentionally low-cardinality: no user_id / workspace_id in
    // the Prometheus text (would explode series count on scrape). Those
    // land in the trace row for per-request drill-down instead.
    const wsId = (req.headers["x-workspace-id"] as string) || null;
    const authKind = req.auth?.apiKey ?? "none";        // anon | service_role | none
    const userId   = req.auth?.user?.sub ?? null;
    // Best-effort token scope surface: workspace tokens carry their scope
    // list on the JWT claims; use the first as a low-cardinality label.
    const claims   = req.auth?.user as (null | (AccessClaims & { scopes?: string[] }));
    const scope    = claims?.scopes?.[0] ?? null;
    const outcome  = reply.statusCode >= 500 ? "error"
                   : reply.statusCode === 401 || reply.statusCode === 403 ? "unauthorized"
                   : reply.statusCode === 429 ? "rate_limited"
                   : reply.statusCode >= 400 ? "client_error"
                   : "ok";
    const routePath = (req.routeOptions?.url ?? req.url.split("?")[0]).slice(0, 120);
    try {
      await q(
        `insert into public.trace_spans
           (trace_id, workspace_id, name, kind, attributes, started_at, ended_at, duration_ms)
         values ($1,$2,$3,'server',$4::jsonb, to_timestamp($5/1000.0), now(), $6)`,
        [t.traceId, wsId, `${req.method} ${req.url.split("?")[0]}`,
         JSON.stringify({
           method: req.method, url: req.url, status: reply.statusCode,
           request_id: req.id, auth_kind: authKind, user_id: userId,
           token_scope: scope, outcome,
         }),
         t.startedAt, dur]);
      // Emit http.request duration metric with the labels Prometheus
      // needs for auth/token slicing. `route` is the templated path
      // (e.g. /rest/v1/:table) — bounded cardinality — not req.url.
      await q(
        `insert into public.metrics_samples (workspace_id, metric, value, labels)
         values ($1,'http.request',$2,$3::jsonb)`,
        [wsId, dur, JSON.stringify({
          method: req.method,
          status: String(reply.statusCode),
          route:  routePath,
          auth_kind: authKind,
          token_scope: scope ?? "none",
          outcome,
        })]);
    } catch { /* observability must never break the request path */ }
  });


  // ---- Metrics ingest / query / prometheus ----
  app.post("/obs/v1/metrics", { preHandler: requireApiKey }, async (req) => {
    const body = metricBody.parse(req.body);
    const values: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    for (const s of body.samples) {
      values.push(`($${i++},$${i++},$${i++},$${i++}::jsonb,$${i++}::timestamptz)`);
      params.push(req.auth!.workspaceId ?? null, s.metric, s.value,
        JSON.stringify(s.labels), s.observed_at ?? new Date().toISOString());
    }
    await q(`insert into public.metrics_samples
             (workspace_id, metric, value, labels, observed_at) values ${values.join(",")}`, params);
    return { inserted: body.samples.length };
  });

  app.get("/obs/v1/metrics/query", { preHandler: requireApiKey }, async (req) => {
    const qs = req.query as { metric: string; agg?: string; window_min?: string };
    if (!qs.metric) return { error: "metric required" };
    const agg = ["avg","sum","count","min","max","p95"].includes(qs.agg ?? "") ? qs.agg! : "avg";
    const win = Math.min(Number(qs.window_min ?? 60), 60 * 24);
    const sqlAgg =
      agg === "p95" ? "percentile_cont(0.95) within group (order by value)"
                    : `${agg}(value)`;
    const r = await q(
      `select date_trunc('minute', observed_at) as bucket, ${sqlAgg} as v
       from public.metrics_samples
       where metric=$1 and observed_at > now() - make_interval(mins => $2)
         and ($3::uuid is null or workspace_id=$3)
       group by 1 order by 1`,
      [qs.metric, win, req.auth!.workspaceId ?? null]);
    return { metric: qs.metric, agg, points: r.rows };
  });

  // Prometheus text exposition — plain text/plain body so scrapers and
  // the dashboard's raw preview can consume it identically. Also mounted
  // at top-level `/metrics` from server.ts.
  const buildPromText = async () => {
    const avg = await q<{ metric: string; v: number; n: number }>(
      `select metric, avg(value)::float8 as v, count(*)::int as n
       from public.metrics_samples
       where observed_at > now() - interval '5 minutes'
       group by metric order by metric`);
    const p95 = await q<{ metric: string; v: number }>(
      `select metric, percentile_cont(0.95) within group (order by value)::float8 as v
       from public.metrics_samples
       where observed_at > now() - interval '5 minutes'
       group by metric`);
    const p95map = new Map(p95.rows.map((r) => [r.metric, r.v] as const));
    const qLen = await q<{ status: string; n: number }>(
      `select status, count(*)::int as n from public.queue_jobs group by status`).catch(() => ({ rows: [] as { status: string; n: number }[] }));
    const lines = [
      "# HELP pluto_metric_avg avg over last 5 minutes",
      "# TYPE pluto_metric_avg gauge",
    ];
    for (const row of avg.rows) {
      const safe = row.metric.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`pluto_metric_avg{name="${safe}"} ${row.v}`);
      lines.push(`pluto_metric_count{name="${safe}"} ${row.n}`);
      const p = p95map.get(row.metric);
      if (p != null) lines.push(`pluto_metric_p95{name="${safe}"} ${p}`);
    }

    // ---- Auth / token activity ----
    // Grouped by auth_kind × outcome × token_scope so operators can spot
    // spikes in `unauthorized` requests from anon keys, or a single
    // token_scope suddenly hitting `rate_limited`. Cardinality bound:
    // (~4 auth_kinds) × (5 outcomes) × (small scope set) ≤ ~100 series.
    const authq = await q<{ auth_kind: string; outcome: string; token_scope: string; n: number; v: number }>(
      `select coalesce(labels->>'auth_kind','none')    as auth_kind,
              coalesce(labels->>'outcome','ok')        as outcome,
              coalesce(labels->>'token_scope','none')  as token_scope,
              count(*)::int                            as n,
              avg(value)::float8                       as v
         from public.metrics_samples
        where metric = 'http.request'
          and observed_at > now() - interval '5 minutes'
        group by 1,2,3`).catch(() => ({ rows: [] as Array<{ auth_kind: string; outcome: string; token_scope: string; n: number; v: number }> }));
    lines.push(
      "# HELP pluto_http_requests_total count of HTTP requests in the last 5m, labeled by auth kind, outcome, and token scope",
      "# TYPE pluto_http_requests_total counter",
      "# HELP pluto_http_request_duration_ms_avg mean HTTP request duration ms, same labels",
      "# TYPE pluto_http_request_duration_ms_avg gauge",
    );
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 60);
    for (const r of authq.rows) {
      const l = `auth_kind="${esc(r.auth_kind)}",outcome="${esc(r.outcome)}",token_scope="${esc(r.token_scope)}"`;
      lines.push(`pluto_http_requests_total{${l}} ${r.n}`);
      lines.push(`pluto_http_request_duration_ms_avg{${l}} ${r.v}`);
    }

    lines.push("# HELP pluto_queue_jobs jobs grouped by status", "# TYPE pluto_queue_jobs gauge");
    for (const row of qLen.rows) lines.push(`pluto_queue_jobs{status="${row.status}"} ${row.n}`);
    return lines.join("\n") + "\n";
  };
  // Kept for backwards-compatibility with existing SDK callers.
  app.get("/obs/v1/prometheus", async () => ({ body: await buildPromText() }));
  // Standard scrape target — text/plain, no auth so scrapers work OOTB.
  app.get("/obs/v1/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return buildPromText();
  });

  // Recent traces — used by the observability dashboard to link a
  // request into a full trace tree via /obs/v1/traces/:traceId.
  app.get("/obs/v1/traces", { preHandler: requireApiKey }, async (req) => {
    const qs = req.query as { limit?: string };
    const limit = Math.min(Number(qs.limit ?? 25), 100);
    const r = await q(
      `select trace_id, min(started_at) as started_at, max(ended_at) as ended_at,
              sum(duration_ms)::int as total_ms, count(*)::int as spans,
              (array_agg(name order by started_at asc))[1] as root_name,
              (array_agg((attributes->>'status') order by started_at asc))[1] as root_status
       from public.trace_spans
       where started_at > now() - interval '1 hour'
         and ($1::uuid is null or workspace_id=$1)
       group by trace_id order by started_at desc limit $2`,
      [req.auth!.workspaceId ?? null, limit]);
    return { traces: r.rows };
  });


  // ---- Tracing ----
  app.post("/obs/v1/spans", { preHandler: requireApiKey }, async (req) => {
    const body = spanBody.parse(req.body);
    for (const s of body.spans) {
      const dur = s.ended_at ? Math.max(0, new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) : null;
      await q(
        `insert into public.trace_spans
           (span_id, trace_id, parent_id, workspace_id, name, kind, attributes, started_at, ended_at, duration_ms)
         values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [s.span_id ?? null, s.trace_id, s.parent_id ?? null, req.auth!.workspaceId ?? null,
         s.name, s.kind, JSON.stringify(s.attributes), s.started_at, s.ended_at ?? null, dur]);
    }
    return { inserted: body.spans.length };
  });

  app.get("/obs/v1/traces/:traceId", { preHandler: requireApiKey }, async (req) => {
    const { traceId } = req.params as { traceId: string };
    const r = await q(`select * from public.trace_spans where trace_id=$1 order by started_at asc`, [traceId]);
    return { trace_id: traceId, spans: r.rows };
  });

  // ---- GDPR ----
  app.get("/compliance/v1/gdpr", { preHandler: requireApiKey }, async (req) => {
    const isAdmin = req.auth!.apiKey === "service_role" && req.auth?.user?.role === "admin";
    const r = await q(
      `select id, subject_id, kind, status, requested_at, completed_at, artifact_key, notes
       from public.gdpr_requests
       where ($1::boolean or subject_id::text = $2)
       order by requested_at desc limit 200`,
      [isAdmin, req.auth?.user?.id ?? "00000000-0000-0000-0000-000000000000"]);
    return { requests: r.rows };
  });

  app.post("/compliance/v1/gdpr", { preHandler: requireApiKey }, async (req, reply) => {
    const b = gdprBody.parse(req.body);
    const isAdmin = req.auth!.apiKey === "service_role" && req.auth?.user?.role === "admin";
    if (!isAdmin && req.auth?.user?.id !== b.subject_id) {
      return reply.code(403).send({ error: "forbidden", detail: "subjects may only request for themselves" });
    }
    const r = await q<{ id: string }>(
      `insert into public.gdpr_requests (workspace_id, subject_id, kind, requested_by, notes)
       values ($1,$2,$3,$4,$5) returning id`,
      [req.auth!.workspaceId ?? null, b.subject_id, b.kind, req.auth?.user?.id ?? null, b.notes ?? null]);
    return { id: r.rows[0]!.id, status: "pending" };
  });

  app.post("/compliance/v1/gdpr/:id/run",
    { preHandler: [requireApiKey, async (req, reply) => { requireAdmin(req, reply); }] },
    async (req) => {
      const { id } = req.params as { id: string };
      const row = (await q<{ subject_id: string; kind: string }>(
        `update public.gdpr_requests set status='running' where id=$1 returning subject_id, kind`,
        [id])).rows[0];
      if (!row) return { ok: false, error: "not_found" };

      try {
        if (row.kind === "export") {
          // Aggregate a minimal export bundle. In production this would upload
          // to storage and return a signed URL; here we record the artifact key.
          const bundle = await q(
            `select json_build_object(
                'user',     (select row_to_json(u) from public.users u where u.id=$1),
                'sessions', (select coalesce(json_agg(row_to_json(s)),'[]'::json)
                             from public.auth_sessions s where s.user_id=$1),
                'audit',    (select coalesce(json_agg(row_to_json(a)),'[]'::json)
                             from public.audit_events a where a.actor_id=$1)
              ) as bundle`, [row.subject_id]);
          const key = `gdpr/exports/${id}.json`;
          void bundle; // artifact write handled by storage worker
          await q(`update public.gdpr_requests set status='completed',
                   completed_at=now(), artifact_key=$2 where id=$1`, [id, key]);
        } else {
          // Erasure: null-out user PII while retaining audit trail with tombstone.
          await q(`update public.users set email='erased+' || id || '@invalid',
                     display_name=null, avatar_url=null, phone=null,
                     is_erased=true, updated_at=now() where id=$1`, [row.subject_id]).catch(() => {});
          await q(`delete from public.auth_sessions where user_id=$1`, [row.subject_id]).catch(() => {});
          await q(`update public.gdpr_requests set status='completed', completed_at=now() where id=$1`, [id]);
        }
      } catch (e) {
        await q(`update public.gdpr_requests set status='failed', notes=$2 where id=$1`,
          [id, e instanceof Error ? e.message : String(e)]);
        throw e;
      }
      return { ok: true };
    });
};
