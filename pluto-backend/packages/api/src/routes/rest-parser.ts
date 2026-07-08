// PostgREST-style query parser — extracted into a standalone module so it
// can be unit-tested without loading the `postgres` driver / fastify.

export const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class RestParseError extends Error {
  detail: Record<string, unknown>;
  constructor(code: string, detail: Record<string, unknown> = {}) {
    super(code);
    this.name = 'RestParseError';
    this.detail = detail;
  }
}

export function safeIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) throw new RestParseError('invalid_identifier', { segment: name });
  return `"${name}"`;
}

export interface Filter {
  col: string;
  op: string;
  value: any;
  negate: boolean;
}

export type Node =
  | { kind: 'leaf'; filter: Filter }
  | { kind: 'group'; op: 'AND' | 'OR'; children: Node[] };

export const OPS: Record<string, string> = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
  like: 'LIKE', ilike: 'ILIKE',
};

export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) throw new RestParseError('unbalanced_parens', { segment: s });
  out.push(s.slice(start));
  return out;
}

export function parseSegment(seg: string): Filter {
  const raw = seg.trim();
  const dot = raw.indexOf('.');
  if (dot < 0) throw new RestParseError('missing_operator', { segment: raw });
  const col = raw.slice(0, dot);
  if (!SAFE_IDENT.test(col)) throw new RestParseError('invalid_column', { segment: raw, column: col });
  let rest = raw.slice(dot + 1);
  let negate = false;
  if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
  const d2 = rest.indexOf('.');
  if (d2 < 0) throw new RestParseError('missing_value', { segment: raw });
  const op = rest.slice(0, d2);
  const value = rest.slice(d2 + 1);
  if (op !== 'is' && op !== 'in' && !OPS[op]) {
    throw new RestParseError('unknown_operator', { segment: raw, operator: op });
  }
  return { col, op, value, negate };
}

export function parseGroup(value: string, op: 'AND' | 'OR'): Node {
  const trimmed = value.trim();
  const m = /^\((.*)\)$/s.exec(trimmed);
  if (!m) throw new RestParseError('bad_group_syntax', { segment: value, expected: `${op.toLowerCase()}=(...)` });
  const parts = splitTopLevel(m[1]);
  const children: Node[] = parts.map((p) => {
    const t = p.trim();
    if (t.startsWith('or(')) return parseGroup(t.slice(2), 'OR');
    if (t.startsWith('and(')) return parseGroup(t.slice(3), 'AND');
    return { kind: 'leaf', filter: parseSegment(t) };
  });
  return { kind: 'group', op, children };
}

export function parseFilters(query: Record<string, any>): {
  nodes: Node[]; select?: string; order?: string; limit?: number; offset?: number;
} {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);
  const nodes: Node[] = [];
  for (const [key, rawVal] of Object.entries(query)) {
    if (reserved.has(key)) continue;
    const vals = Array.isArray(rawVal) ? rawVal : [rawVal];
    for (const v of vals) {
      const s = String(v);
      if (key === 'or' || key === 'and') {
        nodes.push(parseGroup(s, key === 'or' ? 'OR' : 'AND'));
        continue;
      }
      if (!SAFE_IDENT.test(key)) throw new RestParseError('invalid_column', { segment: `${key}=${s}`, column: key });
      nodes.push({ kind: 'leaf', filter: parseSegment(`${key}.${s}`) });
    }
  }
  return {
    nodes,
    select: query.select ? String(query.select) : undefined,
    order: query.order ? String(query.order) : undefined,
    limit: query.limit != null ? Number(query.limit) : undefined,
    offset: query.offset != null ? Number(query.offset) : undefined,
  };
}

function renderLeaf(f: Filter, params: any[]): string {
  const col = safeIdent(f.col);
  let clause: string;
  if (f.op === 'is') {
    const v = String(f.value).toLowerCase();
    if (v === 'null') clause = `${col} IS NULL`;
    else if (v === 'true') clause = `${col} IS TRUE`;
    else if (v === 'false') clause = `${col} IS FALSE`;
    else throw new RestParseError('bad_is_value', { segment: `${f.col}.is.${f.value}` });
  } else if (f.op === 'in') {
    const inner = String(f.value).replace(/^\(|\)$/g, '');
    const raw = splitTopLevel(inner);
    const placeholders = raw.map((_, i) => `$${params.length + i + 1}`).join(',');
    params.push(...raw);
    clause = `${col} IN (${placeholders})`;
  } else if (OPS[f.op]) {
    params.push(f.value);
    clause = `${col} ${OPS[f.op]} $${params.length}`;
  } else {
    throw new RestParseError('unknown_operator', { segment: `${f.col}.${f.op}`, operator: f.op });
  }
  if (f.negate) clause = `NOT (${clause})`;
  return clause;
}

function renderNode(node: Node, params: any[]): string {
  if (node.kind === 'leaf') return renderLeaf(node.filter, params);
  if (!node.children.length) return 'TRUE';
  const joiner = node.op === 'OR' ? ' OR ' : ' AND ';
  return '(' + node.children.map((c) => renderNode(c, params)).join(joiner) + ')';
}

export function buildWhere(nodes: Node[]): { sql: string; params: any[] } {
  if (!nodes.length) return { sql: '', params: [] };
  const params: any[] = [];
  const parts = nodes.map((n) => renderNode(n, params));
  return { sql: 'WHERE ' + parts.join(' AND '), params };
}

export function buildSelect(select?: string): string {
  if (!select || select === '*') return '*';
  return select.split(',').map((s) => safeIdent(s.trim())).join(', ');
}

export function buildOrder(order?: string): string {
  if (!order) return '';
  const parts = order.split(',').map((s) => {
    const [col, dir = 'asc'] = s.trim().split('.');
    const d = dir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    return `${safeIdent(col)} ${d}`;
  });
  return 'ORDER BY ' + parts.join(', ');
}
