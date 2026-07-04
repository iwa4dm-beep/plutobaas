// Phase 47 — In-process structured log ring buffer for log-based alerts.
// Fastify's pino logger already ships lines to stdout; we also mirror into a
// bounded ring buffer so the alert evaluator can scan recent events cheaply.

export interface StructuredLog {
  ts: number;
  level: "info" | "warn" | "error" | "fatal" | "debug";
  route?: string;
  method?: string;
  status?: number;
  trace_id?: string;
  msg: string;
  attrs?: Record<string, unknown>;
}

const MAX = 5000;
const ring: StructuredLog[] = [];

export function pushLog(l: StructuredLog): void {
  ring.push(l);
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
}

export function recentLogs(sinceMs: number): StructuredLog[] {
  const cutoff = Date.now() - sinceMs;
  return ring.filter((l) => l.ts >= cutoff);
}

export function allLogs(): StructuredLog[] { return [...ring]; }
export function resetLogs(): void { ring.length = 0; }

export interface LogAlertRule {
  id: string; slug: string;
  level: "info"|"warn"|"error"|"fatal";
  contains: string | null;
  route_regex: string | null;
  threshold: number;
  window_secs: number;
  webhook_url: string | null;
  enabled: boolean;
}

export function matchesRule(logs: StructuredLog[], rule: LogAlertRule): StructuredLog[] {
  const cutoff = Date.now() - rule.window_secs * 1000;
  const rx = rule.route_regex ? new RegExp(rule.route_regex) : null;
  const levelRank = { debug:0, info:1, warn:2, error:3, fatal:4 } as const;
  const min = levelRank[rule.level];
  return logs.filter((l) =>
    l.ts >= cutoff
    && levelRank[l.level] >= min
    && (!rule.contains || l.msg.toLowerCase().includes(rule.contains.toLowerCase()))
    && (!rx || (l.route ? rx.test(l.route) : false)),
  );
}
