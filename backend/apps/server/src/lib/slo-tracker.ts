// Phase 58 — SLO tracker + alert engine for auth_v4 endpoints.
//
// Each request records `{ endpoint, latency_ms, ok }`. The tracker
// computes windowed error rate and p95 latency, then compares against
// per-endpoint targets to raise/resolve incidents. Incidents carry
// metadata (trace_id sample, window start/end, breach ratio) so an
// operator can pivot from an alert to a specific distributed trace.

export type SloTarget = {
  endpoint: string;         // route pattern
  window_ms: number;        // sliding window
  max_error_rate: number;   // 0..1, e.g. 0.01 for 1%
  p95_latency_ms: number;
};

export type Sample = { endpoint: string; latency_ms: number; ok: boolean; trace_id?: string; ts: number };

export type Incident = {
  id: string;
  endpoint: string;
  opened_at: number;
  closed_at?: number;
  breach: "error_rate" | "latency" | "both";
  error_rate: number;
  p95_latency_ms: number;
  sample_trace_id?: string;
  target: SloTarget;
};

const targets = new Map<string, SloTarget>();
const samples: Sample[] = [];
const incidents = new Map<string, Incident>();     // by endpoint
const MAX_SAMPLES = 20_000;
let seq = 0;

// Sensible defaults for the phase 57 endpoints — callers can override.
const DEFAULTS: SloTarget[] = [
  { endpoint: "POST /auth/v4/saml/:slug/acs", window_ms: 60_000, max_error_rate: 0.05, p95_latency_ms: 500 },
  { endpoint: "POST /auth/v4/scim/v2/Users",  window_ms: 60_000, max_error_rate: 0.02, p95_latency_ms: 300 },
  { endpoint: "PATCH /auth/v4/scim/v2/Users/:id", window_ms: 60_000, max_error_rate: 0.02, p95_latency_ms: 300 },
  { endpoint: "GET /auth/v4/session/resolve", window_ms: 60_000, max_error_rate: 0.05, p95_latency_ms: 150 },
];

export function configureDefaults() { for (const t of DEFAULTS) targets.set(t.endpoint, t); }
export function setTarget(t: SloTarget) { targets.set(t.endpoint, t); }
export function listTargets(): SloTarget[] { return [...targets.values()]; }

export function record(sample: Omit<Sample, "ts">): { incident?: Incident; resolved?: Incident } {
  const s: Sample = { ...sample, ts: Date.now() };
  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  return evaluate(s.endpoint);
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

export function evaluate(endpoint: string): { incident?: Incident; resolved?: Incident } {
  const t = targets.get(endpoint); if (!t) return {};
  const cutoff = Date.now() - t.window_ms;
  const window = samples.filter((s) => s.endpoint === endpoint && s.ts >= cutoff);
  if (window.length === 0) return {};
  const errors = window.filter((s) => !s.ok).length;
  const error_rate = errors / window.length;
  const p95 = percentile(window.map((s) => s.latency_ms), 0.95);
  const badErr = error_rate > t.max_error_rate;
  const badLat = p95 > t.p95_latency_ms;
  const current = incidents.get(endpoint);
  if (badErr || badLat) {
    if (current && !current.closed_at) {
      // Update running incident metrics
      current.error_rate = error_rate;
      current.p95_latency_ms = p95;
      current.breach = badErr && badLat ? "both" : badErr ? "error_rate" : "latency";
      return {};
    }
    const sample_trace_id = window.find((s) => !s.ok && s.trace_id)?.trace_id
                          ?? window.find((s) => s.trace_id)?.trace_id;
    const inc: Incident = {
      id: `inc_${++seq}_${Date.now()}`,
      endpoint,
      opened_at: Date.now(),
      breach: badErr && badLat ? "both" : badErr ? "error_rate" : "latency",
      error_rate,
      p95_latency_ms: p95,
      sample_trace_id,
      target: t,
    };
    incidents.set(endpoint, inc);
    return { incident: inc };
  }
  if (current && !current.closed_at) {
    current.closed_at = Date.now();
    current.error_rate = error_rate;
    current.p95_latency_ms = p95;
    return { resolved: current };
  }
  return {};
}

export function listIncidents(open_only = false): Incident[] {
  const all = [...incidents.values()];
  return open_only ? all.filter((i) => !i.closed_at) : all;
}

export function _resetSloForTests() { targets.clear(); samples.length = 0; incidents.clear(); seq = 0; }
