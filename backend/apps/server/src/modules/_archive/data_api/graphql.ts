// Minimal hand-rolled GraphQL adapter.
//
// Supports a single query root with fields per exposed table:
//   query {
//     todos(where: { user_id: { eq: "..." } }, order: "created_at.desc",
//           limit: 10, offset: 0) { id title done }
//   }
// Mutations:
//   mutation { insert_todos(objects: [{title:"x"}]) { id } }
//   mutation { update_todos(where:{id:{eq:"..."}}, set:{done:true}) { id } }
//   mutation { delete_todos(where:{id:{eq:"..."}}) { id } }
//
// Not a full GraphQL server — no aliases, fragments, subscriptions, or
// nested resolvers. Enough to give Firebase-class DX for the 90%
// query/mutate case without bringing in a new dep.

import type { PoolClient } from "pg";
import { getSchemaSnapshot } from "./introspect.js";

const OPS: Record<string, string> = {
  eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=",
  like: "like", ilike: "ilike",
};

type Node =
  | { kind: "query" | "mutation"; selections: Field[] }
  | Field;
type Field = {
  kind: "field";
  name: string;
  args: Record<string, unknown>;
  selections: Field[];
};

// --- Tiny tokenizer/parser (curly-brace, args-in-parens).
class Parser {
  i = 0;
  constructor(private src: string) {}
  err(msg: string): never { throw new Error(`gql: ${msg} at ${this.i}`); }
  skip() { while (this.i < this.src.length && /\s|,/.test(this.src[this.i])) this.i++; }
  eof() { this.skip(); return this.i >= this.src.length; }
  peek(): string { this.skip(); return this.src[this.i] ?? ""; }
  consume(c: string) { this.skip(); if (this.src[this.i] !== c) this.err(`expected ${c}`); this.i++; }
  ident(): string {
    this.skip();
    const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(this.src.slice(this.i));
    if (!m) this.err("ident");
    this.i += m[0].length; return m[0];
  }
  value(vars: Record<string, unknown>): unknown {
    this.skip();
    const c = this.src[this.i];
    if (c === '"') {
      const end = this.src.indexOf('"', this.i + 1);
      if (end < 0) this.err("unterminated string");
      const s = this.src.slice(this.i + 1, end); this.i = end + 1; return s;
    }
    if (c === "$") {
      this.i++; const name = this.ident(); return vars[name];
    }
    if (c === "[") {
      this.i++; const arr: unknown[] = [];
      while (this.peek() !== "]") { arr.push(this.value(vars)); this.skip(); if (this.peek() === ",") this.i++; }
      this.i++; return arr;
    }
    if (c === "{") return this.object(vars);
    const m = /^(-?\d+(\.\d+)?|true|false|null)/.exec(this.src.slice(this.i));
    if (m) {
      this.i += m[0].length;
      if (m[0] === "true") return true;
      if (m[0] === "false") return false;
      if (m[0] === "null") return null;
      return Number(m[0]);
    }
    // bare enum-like: treat as string
    return this.ident();
  }
  object(vars: Record<string, unknown>): Record<string, unknown> {
    this.consume("{"); const out: Record<string, unknown> = {};
    while (this.peek() !== "}") {
      const k = this.ident(); this.consume(":"); out[k] = this.value(vars); this.skip();
      if (this.peek() === ",") this.i++;
    }
    this.consume("}"); return out;
  }
  args(vars: Record<string, unknown>): Record<string, unknown> {
    if (this.peek() !== "(") return {};
    this.i++; const out: Record<string, unknown> = {};
    while (this.peek() !== ")") {
      const k = this.ident(); this.consume(":"); out[k] = this.value(vars); this.skip();
      if (this.peek() === ",") this.i++;
    }
    this.i++; return out;
  }
  selectionSet(vars: Record<string, unknown>): Field[] {
    this.consume("{"); const out: Field[] = [];
    while (this.peek() !== "}") {
      const name = this.ident();
      const args = this.args(vars);
      const selections = this.peek() === "{" ? this.selectionSet(vars) : [];
      out.push({ kind: "field", name, args, selections });
      this.skip();
    }
    this.consume("}"); return out;
  }
  parse(vars: Record<string, unknown>): Node {
    this.skip();
    let kind: "query" | "mutation" = "query";
    if (/^query\b/.test(this.src.slice(this.i))) { this.i += 5; }
    else if (/^mutation\b/.test(this.src.slice(this.i))) { this.i += 8; kind = "mutation"; }
    return { kind, selections: this.selectionSet(vars) };
  }
}

// --- SQL builder ------------------------------------------------------
function buildWhere(where: Record<string, unknown> | undefined, startIdx: number)
: { sql: string; params: unknown[] } {
  if (!where || Object.keys(where).length === 0) return { sql: "", params: [] };
  const parts: string[] = []; const params: unknown[] = []; let i = startIdx;
  for (const [col, exprRaw] of Object.entries(where)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) throw new Error(`bad_col:${col}`);
    const expr = exprRaw as Record<string, unknown>;
    for (const [op, val] of Object.entries(expr)) {
      if (op === "in" && Array.isArray(val)) {
        const ph = val.map(() => `$${i++}`).join(",");
        params.push(...val); parts.push(`"${col}" in (${ph})`);
      } else if (op === "is_null") {
        parts.push(`"${col}" is ${val ? "null" : "not null"}`);
      } else if (OPS[op]) {
        parts.push(`"${col}" ${OPS[op]} $${i++}`); params.push(val);
      } else throw new Error(`bad_op:${op}`);
    }
  }
  return { sql: `where ${parts.join(" and ")}`, params };
}

// --- Executor ---------------------------------------------------------
export type GqlContext = { client: PoolClient };

export async function executeGraphql(
  query: string,
  variables: Record<string, unknown> = {},
  ctx: GqlContext,
): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
  const snap = await getSchemaSnapshot();
  const tables = new Map(snap.tables.map((t) => [t.name, t]));
  let ast: Node;
  try { ast = new Parser(query).parse(variables); }
  catch (e) { return { errors: [{ message: (e as Error).message }] }; }
  if (ast.kind !== "query" && ast.kind !== "mutation") return { errors: [{ message: "bad_root" }] };

  const data: Record<string, unknown> = {};
  const errors: { message: string }[] = [];
  for (const f of ast.selections) {
    try {
      let table = f.name, op: "select" | "insert" | "update" | "delete" = "select";
      if (f.name.startsWith("insert_")) { table = f.name.slice(7); op = "insert"; }
      else if (f.name.startsWith("update_")) { table = f.name.slice(7); op = "update"; }
      else if (f.name.startsWith("delete_")) { table = f.name.slice(7); op = "delete"; }
      const meta = tables.get(table);
      if (!meta) throw new Error(`unknown_table:${table}`);
      const proj = f.selections.length
        ? f.selections.map((s) => `"${s.name}"`).join(",") : "*";

      if (op === "select") {
        const w = buildWhere(f.args.where as Record<string, unknown>, 1);
        const limit = Math.min(1000, Number(f.args.limit ?? 100));
        const offset = Number(f.args.offset ?? 0);
        let order = "";
        if (typeof f.args.order === "string") {
          const [col, dir = "asc"] = (f.args.order as string).split(".");
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col) || (dir !== "asc" && dir !== "desc"))
            throw new Error("bad_order");
          order = `order by "${col}" ${dir}`;
        }
        const sql = `select ${proj} from public."${table}" ${w.sql} ${order} limit ${limit} offset ${offset}`;
        const r = await ctx.client.query(sql, w.params);
        data[f.name] = r.rows;
      } else if (op === "insert") {
        const rows = (f.args.objects ?? f.args.object) as Record<string, unknown> | Record<string, unknown>[];
        const arr = Array.isArray(rows) ? rows : [rows];
        if (arr.length === 0) throw new Error("empty_objects");
        const cols = Object.keys(arr[0]);
        const params: unknown[] = [];
        const tuples = arr.map((r) => {
          const vs = cols.map((c) => { params.push(r[c]); return `$${params.length}`; });
          return `(${vs.join(",")})`;
        });
        const sql = `insert into public."${table}" (${cols.map((c) => `"${c}"`).join(",")}) values ${tuples.join(",")} returning ${proj}`;
        const r = await ctx.client.query(sql, params);
        data[f.name] = r.rows;
      } else if (op === "update") {
        const set = f.args.set as Record<string, unknown>;
        if (!set) throw new Error("missing_set");
        const params: unknown[] = [];
        const sets = Object.keys(set).map((c) => { params.push(set[c]); return `"${c}" = $${params.length}`; }).join(",");
        const w = buildWhere(f.args.where as Record<string, unknown>, params.length + 1);
        const sql = `update public."${table}" set ${sets} ${w.sql} returning ${proj}`;
        const r = await ctx.client.query(sql, [...params, ...w.params]);
        data[f.name] = r.rows;
      } else {
        const w = buildWhere(f.args.where as Record<string, unknown>, 1);
        if (!w.sql) throw new Error("delete_requires_where");
        const sql = `delete from public."${table}" ${w.sql} returning ${proj}`;
        const r = await ctx.client.query(sql, w.params);
        data[f.name] = r.rows;
      }
    } catch (e) {
      errors.push({ message: `${f.name}: ${(e as Error).message}` });
    }
  }
  return errors.length ? { data, errors } : { data };
}
