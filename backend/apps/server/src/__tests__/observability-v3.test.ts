// Phase 58 — Observability v3 unit tests.
import { describe, it, expect, beforeEach } from "vitest";
import * as tr from "../lib/tracing.js";
import * as slo from "../lib/slo-tracker.js";
import * as iso from "../lib/session-isolation.js";

beforeEach(() => {
  tr._resetTracesForTests(); slo._resetSloForTests(); iso._resetSessionsForTests();
  iso.setAuthEventContext(null);
});

describe("tracing", () => {
  it("propagates trace context from a W3C traceparent header", () => {
    const parsed = tr.parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(parsed?.trace_id).toBe("0af7651916cd43dd8448eb211c80319c");
    const s = tr.startSpan("child", parsed);
    tr.endSpan(s, "ok");
    expect(s.trace_id).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(s.parent_id).toBe("b7ad6b7169203331");
  });
  it("rejects malformed traceparent", () => {
    expect(tr.parseTraceparent("garbage")).toBeNull();
    expect(tr.parseTraceparent("00-short-short-01")).toBeNull();
  });
  it("groups spans by trace id", () => {
    const a = tr.startSpan("a"); tr.endSpan(a);
    const b = tr.startSpan("b", { trace_id: a.trace_id, parent_id: a.span_id }); tr.endSpan(b);
    expect(tr.getTrace(a.trace_id)).toHaveLength(2);
  });
});

describe("audit trace correlation", () => {
  it("logAuth picks up the request's trace_id via context provider", () => {
    iso.setAuthEventContext(() => ({ trace_id: "abc123" }));
    const ev = iso.logAuth({ workspace_id: "w1", user_email: "u@e.io", action: "session.create", status: "ok" });
    expect(ev.trace_id).toBe("abc123");
  });
  it("explicit trace_id in the input overrides the context", () => {
    iso.setAuthEventContext(() => ({ trace_id: "ctx" }));
    const ev = iso.logAuth({ workspace_id: "w1", user_email: null, action: "x", status: "ok", trace_id: "explicit" });
    expect(ev.trace_id).toBe("explicit");
  });
});

describe("slo tracker", () => {
  it("opens an incident when error rate exceeds target and resolves once it recovers", () => {
    slo.setTarget({ endpoint: "GET /x", window_ms: 60_000, max_error_rate: 0.1, p95_latency_ms: 1000 });
    for (let i = 0; i < 8; i++) slo.record({ endpoint: "GET /x", latency_ms: 10, ok: true });
    for (let i = 0; i < 4; i++) slo.record({ endpoint: "GET /x", latency_ms: 10, ok: false, trace_id: `t${i}` });
    const open = slo.listIncidents(true);
    expect(open[0]?.breach).toBe("error_rate");
    expect(open[0]?.sample_trace_id).toBeDefined();
    // Now flood with successes so the window ratio drops below the target.
    let last: { resolved?: slo.Incident } = {};
    for (let i = 0; i < 200; i++) last = slo.record({ endpoint: "GET /x", latency_ms: 10, ok: true });
    expect(last.resolved).toBeDefined();
  });
  it("opens on latency breach when p95 exceeds target", () => {
    slo.setTarget({ endpoint: "POST /y", window_ms: 60_000, max_error_rate: 1, p95_latency_ms: 100 });
    for (let i = 0; i < 20; i++) slo.record({ endpoint: "POST /y", latency_ms: 500, ok: true });
    const inc = slo.listIncidents(true);
    expect(inc[0]?.breach).toBe("latency");
  });
});
