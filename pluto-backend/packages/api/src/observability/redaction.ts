/**
 * PII redaction for exported / displayed trace events.
 *
 * Rules live in `admin.pii_redaction_rules` and are pulled with a short TTL
 * cache so listing/exporting stays fast even under heavy support load.
 * Redaction runs at read-time (list, get, export), not at capture time —
 * this keeps the raw audit trail intact in the DB while letting operators
 * tweak rules without re-running migrations.
 *
 * Fields covered: message, hint, detail, stack, url, user_agent, and every
 * value inside the `fields` map. `applies_to` on a rule scopes which columns
 * to touch; `all` (default) hits every string field.
 */
import type { Config } from '../config.js';
import { getSql } from '../db/pool.js';
import type { ErrorEvent } from './error-log.js';

export type RedactionRule = {
  id: string;
  name: string;
  pattern: string;
  applies_to: string[];
  replacement: string;
  enabled: boolean;
  note: string | null;
};

type CachedRule = { re: RegExp; applies: Set<string>; replacement: string };

let cache: { at: number; rules: CachedRule[] } | null = null;
const TTL_MS = 30_000;

export async function loadRules(cfg: Config, force = false): Promise<CachedRule[]> {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) return cache.rules;
  try {
    const sql = getSql(cfg);
    const rows = await sql<RedactionRule[]>`
      SELECT id, name, pattern, applies_to, replacement, enabled, note
        FROM admin.pii_redaction_rules
       WHERE enabled = true
    `;
    const rules: CachedRule[] = [];
    for (const r of rows) {
      try {
        rules.push({
          re: new RegExp(r.pattern, 'gi'),
          applies: new Set(r.applies_to?.length ? r.applies_to : ['all']),
          replacement: r.replacement,
        });
      } catch {
        // Invalid regex — skip silently; validated at insert time already.
      }
    }
    cache = { at: now, rules };
    return rules;
  } catch {
    return cache?.rules ?? [];
  }
}

export function invalidateRulesCache(): void {
  cache = null;
}

function scrub(value: string, rules: CachedRule[], column: string): string {
  let out = value;
  for (const r of rules) {
    if (r.applies.has('all') || r.applies.has(column)) {
      out = out.replace(r.re, r.replacement);
    }
  }
  return out;
}

export function applyRedaction(evt: ErrorEvent, rules: CachedRule[]): ErrorEvent {
  if (!rules.length) return evt;
  const out: ErrorEvent = { ...evt };
  if (out.message) out.message = scrub(out.message, rules, 'message');
  if (out.hint) out.hint = scrub(out.hint, rules, 'hint');
  if (out.detail) out.detail = scrub(out.detail, rules, 'detail');
  if (out.stack) out.stack = scrub(out.stack, rules, 'stack');
  if (out.url) out.url = scrub(out.url, rules, 'url');
  if (out.userAgent) out.userAgent = scrub(out.userAgent, rules, 'user_agent');
  if (out.fields) {
    const f: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.fields)) f[k] = scrub(String(v), rules, 'fields');
    out.fields = f;
  }
  return out;
}

/** Validate a regex pattern; throws Zod-compatible error on failure. */
export function assertValidPattern(pattern: string): void {
  try { new RegExp(pattern, 'gi'); }
  catch (e) {
    const err: any = new Error(`Invalid regex: ${(e as Error).message}`);
    err.statusCode = 400;
    err.code = 'invalid_pattern';
    throw err;
  }
}
