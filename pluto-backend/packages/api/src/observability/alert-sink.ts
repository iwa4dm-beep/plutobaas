/**
 * Spike alert sink.
 *
 * Complements `recordFailure()` in errors.ts by tracking spike rates and
 * carrying traceId samples + a lookup URL. Emits structured alerts that
 * external sinks (journald/loki/alertmanager) can page on.
 *
 * Two spike detectors, both PII-free:
 *   - `5xx:<tag>`          — internal server errors bucketed by tag
 *   - `validation_failed`  — Zod validation rejections across all endpoints
 *
 * The alert payload includes up to 5 traceId samples so a human can jump
 * straight to `/admin/v1/traces/:traceId` for full context.
 */

const WINDOW_MS = 5 * 60_000;
const THRESHOLD = 10;
const ALERT_COOLDOWN_MS = 15 * 60_000;
const SAMPLE_CAP = 5;

type Bucket = {
  count: number;
  firstAt: number;
  lastAlertAt: number;
  samples: string[];       // recent traceIds
};

const buckets = new Map<string, Bucket>();

export type SpikeAlert = {
  tag: string;
  count: number;
  windowMs: number;
  threshold: number;
  sampleTraceIds: string[];
  lookupUrlTemplate: string;      // "/admin/v1/traces/{traceId}"
  listUrl: string;                // "/admin/v1/traces?tag=<tag>&limit=50"
};

/**
 * Record a failure with a traceId sample. Returns a SpikeAlert when the
 * bucket crosses THRESHOLD within WINDOW_MS (respecting cooldown). The
 * caller should log the alert with `alert=true`.
 */
export function recordFailureWithSample(tag: string, traceId?: string | null): SpikeAlert | null {
  const now = Date.now();
  let b = buckets.get(tag);
  if (!b || now - b.firstAt > WINDOW_MS) {
    b = { count: 1, firstAt: now, lastAlertAt: b?.lastAlertAt || 0, samples: [] };
    if (traceId) b.samples.push(traceId);
    buckets.set(tag, b);
    return null;
  }
  b.count += 1;
  if (traceId && !b.samples.includes(traceId)) {
    b.samples.push(traceId);
    if (b.samples.length > SAMPLE_CAP) b.samples.shift();
  }
  if (b.count >= THRESHOLD && now - b.lastAlertAt > ALERT_COOLDOWN_MS) {
    b.lastAlertAt = now;
    const listUrl = `/admin/v1/traces?tag=${encodeURIComponent(tag.replace(/^5xx:/, ''))}&limit=50`;
    return {
      tag,
      count: b.count,
      windowMs: WINDOW_MS,
      threshold: THRESHOLD,
      sampleTraceIds: [...b.samples],
      lookupUrlTemplate: '/admin/v1/traces/{traceId}',
      listUrl,
    };
  }
  return null;
}

/** Test-only. */
export function _resetAlertsForTests(): void {
  buckets.clear();
}
