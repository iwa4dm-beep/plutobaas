-- Phase 58 — Observability v3 (distributed traces, live tail, SLO alerting)
--
-- Runtime state is in-memory for the tests; this migration ships the
-- durable ledger tables so audits + traces + incidents can be persisted
-- in production without changing the API.

BEGIN;

CREATE TABLE IF NOT EXISTS public.obs3_spans (
  span_id      text PRIMARY KEY,
  trace_id     text NOT NULL,
  parent_id    text,
  name         text NOT NULL,
  service      text NOT NULL,
  start_ns     bigint NOT NULL,
  end_ns       bigint,
  status       text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error')),
  attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS obs3_spans_trace_idx ON public.obs3_spans(trace_id);
CREATE INDEX IF NOT EXISTS obs3_spans_created_idx ON public.obs3_spans(created_at DESC);

CREATE TABLE IF NOT EXISTS public.obs3_slo_targets (
  endpoint         text PRIMARY KEY,
  window_ms        integer NOT NULL,
  max_error_rate   double precision NOT NULL,
  p95_latency_ms   integer NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.obs3_incidents (
  id                text PRIMARY KEY,
  endpoint          text NOT NULL,
  breach            text NOT NULL CHECK (breach IN ('error_rate','latency','both')),
  error_rate        double precision NOT NULL,
  p95_latency_ms    integer NOT NULL,
  sample_trace_id   text,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz
);
CREATE INDEX IF NOT EXISTS obs3_incidents_open_idx ON public.obs3_incidents(endpoint) WHERE closed_at IS NULL;

REVOKE ALL ON public.obs3_spans, public.obs3_slo_targets, public.obs3_incidents FROM PUBLIC, anon, authenticated;
GRANT  ALL ON public.obs3_spans, public.obs3_slo_targets, public.obs3_incidents TO service_role;
ALTER TABLE public.obs3_spans        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.obs3_slo_targets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.obs3_incidents    ENABLE ROW LEVEL SECURITY;

COMMIT;
