// Phase 58 — Distributed tracing primitives (OpenTelemetry-compatible).
//
// Minimal, allocation-light tracer that produces W3C trace-context headers
// (`traceparent`) so downstream services + real OTel collectors can pick up
// the spans. In-process, spans are exported to a bounded ring buffer that
// the observability_v3 plugin serves over HTTP and SSE.

import { randomBytes } from "node:crypto";

export type SpanStatus = "ok" | "error";

export type Span = {
  trace_id: string;      // 16-byte hex
  span_id: string;       // 8-byte hex
  parent_id?: string;
  name: string;
  service: string;
  start_ns: number;
  end_ns?: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean>;
};

const MAX = 5000;
const buffer: Span[] = [];
let serviceName = "pluto-api";

type Listener = (s: Span) => void;
const listeners = new Set<Listener>();

export function configureTracing(opts: { service?: string } = {}) {
  if (opts.service) serviceName = opts.service;
}

export function subscribeSpans(fn: Listener): () => void {
  listeners.add(fn); return () => listeners.delete(fn);
}

function hex(bytes: number): string { return randomBytes(bytes).toString("hex"); }
function nowNs(): number { return Date.now() * 1_000_000; }

// Parse a W3C traceparent header: version-traceid-parentid-flags.
export function parseTraceparent(h: string | undefined): { trace_id: string; parent_id: string } | null {
  if (!h) return null;
  const parts = h.split("-");
  if (parts.length !== 4) return null;
  const [, trace_id, parent_id] = parts;
  if (!/^[0-9a-f]{32}$/.test(trace_id) || !/^[0-9a-f]{16}$/.test(parent_id)) return null;
  return { trace_id, parent_id };
}

export function formatTraceparent(trace_id: string, span_id: string): string {
  return `00-${trace_id}-${span_id}-01`;
}

export function startSpan(name: string, parent?: { trace_id: string; parent_id?: string } | null): Span {
  const trace_id = parent?.trace_id ?? hex(16);
  const span: Span = {
    trace_id,
    span_id:   hex(8),
    parent_id: parent?.parent_id,
    name,
    service:   serviceName,
    start_ns:  nowNs(),
    status:    "ok",
    attributes: {},
  };
  return span;
}

export function endSpan(span: Span, status: SpanStatus = "ok", attrs: Record<string, string | number | boolean> = {}) {
  span.end_ns = nowNs();
  span.status = status;
  Object.assign(span.attributes, attrs);
  buffer.push(span);
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  for (const l of listeners) { try { l(span); } catch { /* noop */ } }
}

export function listSpans(filter: { trace_id?: string; name?: string; limit?: number } = {}): Span[] {
  let out = buffer;
  if (filter.trace_id) out = out.filter((s) => s.trace_id === filter.trace_id);
  if (filter.name)     out = out.filter((s) => s.name === filter.name);
  const lim = Math.max(1, Math.min(1000, filter.limit ?? 200));
  return out.slice(-lim).reverse();
}

export function getTrace(trace_id: string): Span[] {
  return buffer.filter((s) => s.trace_id === trace_id).sort((a, b) => a.start_ns - b.start_ns);
}

export function _resetTracesForTests() { buffer.length = 0; listeners.clear(); }
