// Lightweight SQL classifier. Not a full parser — meant to gate destructive
// verbs and enforce read-only mode. The DB (READ ONLY tx) is authoritative.

export type SqlClass = 'safe' | 'write' | 'schema' | 'unknown';

export interface Classification {
  class: SqlClass;
  verb: string;
  destructive: boolean;
  affects: string[];       // extracted table/relation names (best-effort)
  reason?: string;
}

const SAFE_VERBS = new Set(['select', 'with', 'explain', 'show', 'values', 'table', 'analyze']);
const WRITE_VERBS = new Set(['insert', 'update', 'delete', 'merge', 'copy']);
const SCHEMA_VERBS = new Set([
  'drop', 'truncate', 'alter', 'create', 'grant', 'revoke',
  'reindex', 'cluster', 'vacuum', 'refresh', 'comment', 'rename',
]);

function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
}

export function classifySql(rawSql: string): Classification {
  const sql = stripComments(rawSql);
  if (!sql) return { class: 'unknown', verb: '', destructive: false, affects: [], reason: 'empty' };

  // Reject inline interpolation attempts by callers (client should use params).
  if (/\$\{/.test(sql)) {
    return {
      class: 'unknown', verb: '', destructive: true, affects: [],
      reason: 'template literals (${...}) not allowed — use positional params ($1, $2, …)',
    };
  }

  const firstWordMatch = sql.match(/^\s*([a-zA-Z]+)/);
  const verb = (firstWordMatch?.[1] ?? '').toLowerCase();

  // Handle CTE / with: peek at final DML verb.
  let effectiveVerb = verb;
  if (verb === 'with') {
    const m = sql.match(/\)\s*(select|insert|update|delete|merge)\b/i);
    if (m) effectiveVerb = m[1].toLowerCase();
  }

  const affects = Array.from(
    sql.matchAll(/\b(?:from|join|into|update|table|on)\s+([a-zA-Z_][\w.]*)/gi),
  ).map((m) => m[1]);

  if (SAFE_VERBS.has(effectiveVerb) && !WRITE_VERBS.has(effectiveVerb)) {
    return { class: 'safe', verb: effectiveVerb, destructive: false, affects };
  }
  if (WRITE_VERBS.has(effectiveVerb)) {
    return { class: 'write', verb: effectiveVerb, destructive: true, affects };
  }
  if (SCHEMA_VERBS.has(effectiveVerb)) {
    return { class: 'schema', verb: effectiveVerb, destructive: true, affects };
  }
  return { class: 'unknown', verb, destructive: true, affects, reason: 'unknown verb — treated as destructive' };
}

// Split by top-level semicolons (naive — good enough for the runner).
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inSingle = false, inDouble = false, inDollar = false, dollarTag = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    buf += c;
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) { if (c === '"') inDouble = false; continue; }
    if (inDollar) {
      if (sql.slice(i).startsWith(dollarTag)) { buf += dollarTag.slice(1); i += dollarTag.length - 1; inDollar = false; }
      continue;
    }
    if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === '$') {
      const m = sql.slice(i).match(/^\$[a-zA-Z_]*\$/);
      if (m) { dollarTag = m[0]; inDollar = true; buf += m[0].slice(1); i += m[0].length - 1; }
    } else if (c === ';') {
      const trimmed = buf.slice(0, -1).trim();
      if (trimmed) out.push(trimmed);
      buf = '';
    }
  }
  const rest = buf.trim();
  if (rest) out.push(rest);
  return out;
}
