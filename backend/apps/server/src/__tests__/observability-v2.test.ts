// Phase 47 — unit tests for OTel primitives, RED metrics, SLO burn-rate, log alerts.

import { describe, it, expect, beforeEach } from "vitest";
import {
  newTraceId, newSpanId, parseTraceparent, formatTraceparent, toOtlpPayload,
} from "../lib/otel.js";
import { recordRequest, toPrometheus, snapshot, resetRedMetrics } from "../lib/red-metrics.js";
import { burnRate, BURN_WINDOWS } from "../lib/slo.js";
import { pushLog, matchesRule, resetLogs, type LogAlertRule } from "../lib/log-buffer.js";

describe("OTel primitives", () => {
  it("mints hex ids of correct length", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("round-trips a W3C traceparent", () => {
    const tid = newTraceId(); const sid = newSpanId();
    const tp = formatTraceparent(tid, sid, true);
    const parsed = parseTraceparent(tp);
    expect(parsed).toEqual({ traceId: tid, spanId: sid, sampled: true });
  });

  it("rejects malformed traceparent", () => {
    expect(parseTraceparent("bad")).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent("00-zzz-yyy-01")).toBeNull();
  });

  it("serializes spans into OTLP JSON with resourceSpans", () => {
    const payload = toOtlpPayload([{
      traceId: newTraceId(), spanId: newSpanId(), parentId: null,
      name: "GET /x", kind: "server", service: "svc",
      startedAt: 1_000, endedAt: 1_050, status: 1, attributes: { a: 1, b: "s" }, events: [],
    }]) as { resourceSpans: unknown[] };
    expect(payload.resourceSpans).toHaveLength(1);
  });
});

describe("RED metrics", () => {
  beforeEach(() => resetRedMetrics());

  it("counts and bucketizes requests", () => {
    recordRequest("/a", "GET", 200, 3);
    recordRequest("/a", "GET", 200, 300);
    recordRequest("/a", "GET", 500, 12);
    const s = snapshot();
    const reqs = s.requests.filter(r => r.route === "/a");
    const ok  = reqs.find(r => r.status_class === "2xx");
    const err = reqs.find(r => r.status_class === "5xx");
    expect(ok?.count).toBe(2);
    expect(err?.count).toBe(1);
    // Prometheus exposition renders every histogram bucket plus +Inf.
    const text = toPrometheus();
    expect(text).toContain("pluto_http_requests_total");
    expect(text).toContain("pluto_http_request_duration_ms_bucket");
    expect(text).toContain('le="inf"');
  });
});

describe("SLO burn rate", () => {
  it("computes burn = ratio / (1 - objective)", () => {
    // 99.9% objective, 0.5% error rate → burn ≈ 5
    expect(burnRate(0.005, 0.999)).toBeCloseTo(5, 3);
  });
  it("multi-window definitions cover 5m/1h/6h/24h", () => {
    expect(BURN_WINDOWS.map(w => w.label)).toEqual(["5m","1h","6h","24h"]);
  });
});

describe("Log-based alerts", () => {
  const rule: LogAlertRule = {
    id: "r1", slug: "r1", level: "error", contains: "boom", route_regex: "^/api",
    threshold: 2, window_secs: 60, webhook_url: null, enabled: true,
  };

  it("matches by level + contains + route regex within window", () => {
    resetLogs();
    pushLog({ ts: Date.now(), level: "error", msg: "boom happened", route: "/api/x" });
    pushLog({ ts: Date.now(), level: "warn",  msg: "boom warn",     route: "/api/y" });
    pushLog({ ts: Date.now(), level: "error", msg: "silent",        route: "/api/z" });
    pushLog({ ts: Date.now(), level: "error", msg: "boom two",      route: "/other" });
    const hits = matchesRule([
      { ts: Date.now(), level: "error", msg: "boom happened", route: "/api/x" },
      { ts: Date.now(), level: "error", msg: "boom again",    route: "/api/x" },
    ], rule);
    expect(hits).toHaveLength(2);
  });
});
