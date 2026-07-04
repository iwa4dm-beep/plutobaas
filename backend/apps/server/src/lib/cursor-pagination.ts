// Phase 59 — Cursor-based pagination utility.
//
// Opaque, base64url-encoded cursors that encode (order_key, value, id).
// Callers pass a stable sort column + tiebreaker id column; we enforce
// strict-monotone iteration so no row is skipped or duplicated even when
// duplicate order keys exist. Cursors are self-describing so a bad
// cursor is rejected before it hits the DB.

export type Direction = "asc" | "desc";
export type CursorSpec = { order_by: string; direction: Direction; id_column: string };

export type Cursor = { k: unknown; i: string; s: string /* signature of spec */ };

function specSig(spec: CursorSpec): string {
  return `${spec.order_by}|${spec.direction}|${spec.id_column}`;
}

export function encodeCursor(row: Record<string, unknown>, spec: CursorSpec): string {
  const c: Cursor = { k: row[spec.order_by], i: String(row[spec.id_column]), s: specSig(spec) };
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(s: string, spec: CursorSpec): Cursor {
  let parsed: Cursor;
  try { parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8")); }
  catch { throw new Error("cursor_malformed"); }
  if (parsed.s !== specSig(spec)) throw new Error("cursor_spec_mismatch");
  return parsed;
}

// In-memory pager for arrays (used by tests and RPC handlers that already
// have their result set in memory). DB adapters should translate the same
// semantics into a WHERE clause.
export function paginate<T extends Record<string, unknown>>(
  rows: T[],
  spec: CursorSpec,
  opts: { limit: number; cursor?: string },
): { items: T[]; next_cursor: string | null; has_more: boolean } {
  const limit = Math.max(1, Math.min(1000, opts.limit));
  const cmp = (a: unknown, b: unknown) => {
    if (a === b) return 0;
    if (a === null || a === undefined) return spec.direction === "asc" ? -1 : 1;
    if (b === null || b === undefined) return spec.direction === "asc" ? 1 : -1;
    return (a as number | string) < (b as number | string) ? -1 : 1;
  };
  const sorted = [...rows].sort((a, b) => {
    const p = cmp(a[spec.order_by], b[spec.order_by]);
    const dir = spec.direction === "asc" ? 1 : -1;
    if (p !== 0) return p * dir;
    return String(a[spec.id_column]).localeCompare(String(b[spec.id_column])) * dir;
  });

  let start = 0;
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor, spec);
    start = sorted.findIndex((r) => {
      const p = cmp(r[spec.order_by], c.k);
      const dir = spec.direction === "asc" ? 1 : -1;
      if (p !== 0) return p * dir > 0;
      return String(r[spec.id_column]).localeCompare(String(c.i)) * dir > 0;
    });
    if (start < 0) start = sorted.length;
  }
  const slice = sorted.slice(start, start + limit);
  const has_more = start + limit < sorted.length;
  const next_cursor = has_more && slice.length ? encodeCursor(slice[slice.length - 1], spec) : null;
  return { items: slice, next_cursor, has_more };
}

// Translate cursor into a WHERE fragment for pg — used by adapters. The
// caller is responsible for parameter binding.
export function whereFromCursor(spec: CursorSpec, cursor: Cursor, startParam = 1)
: { sql: string; params: unknown[]; nextParam: number } {
  const op = spec.direction === "asc" ? ">" : "<";
  const sql = `("${spec.order_by}", "${spec.id_column}") ${op} ($${startParam}, $${startParam + 1})`;
  return { sql, params: [cursor.k, cursor.i], nextParam: startParam + 2 };
}
