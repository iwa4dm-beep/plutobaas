// Phase 44 — PostgREST-style `?select=` parser + expansion.
//
// Grammar (whitespace-insensitive):
//
//   select   := field ( ',' field )*
//   field    := ident                             — simple column
//              | ident '(' select ')'             — embedded relation, all cols
//              | ident '(' fields_or_all ')'      — embedded relation, chosen cols
//   fields_or_all := '*' | select
//
// Examples:
//   select=id,title,author(name),comments(id,body)
//   select=*,tags(*)
//
// The expander resolves each embedded relation by looking up a foreign
// key between the parent and child table in information_schema. It
// supports either direction (child → parent via child.fk or parent → child
// via child.fk) and picks the first FK it finds — good enough for the
// common 1:1 / 1:N modelling Supabase surfaces the same way.

import type { PoolClient } from "pg";

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/i;

export type SelectNode = {
  name: string;                // column or relation local name
  columns?: SelectNode[] | "*"; // undefined => plain column, else relation
};

export function parseSelect(src: string): SelectNode[] {
  const tokens = tokenize(src);
  let i = 0;

  function parseList(): SelectNode[] {
    const out: SelectNode[] = [];
    while (i < tokens.length && tokens[i] !== ")") {
      const name = tokens[i++];
      if (name === "*") { out.push({ name: "*" }); }
      else {
        if (!IDENT.test(name)) throw new Error(`invalid identifier: ${name}`);
        if (tokens[i] === "(") {
          i++; // consume (
          const inner = tokens[i] === "*"
            ? (i++, "*" as const)
            : parseList();
          if (tokens[i] !== ")") throw new Error("missing )");
          i++;
          out.push({ name, columns: inner });
        } else {
          out.push({ name });
        }
      }
      if (tokens[i] === ",") i++;
      else break;
    }
    return out;
  }

  return parseList();
}

function tokenize(src: string): string[] {
  return src.match(/[A-Za-z_][A-Za-z0-9_]*|\*|\(|\)|,/g) ?? [];
}

type FkEdge = {
  fromSchema: string; fromTable: string; fromColumn: string;
  toSchema:   string; toTable:   string; toColumn:   string;
};

async function findFk(
  client: PoolClient,
  parent: { schema: string; table: string },
  child:  { schema: string; table: string },
): Promise<{ direction: "child_to_parent" | "parent_to_child"; edge: FkEdge } | null> {
  // Child references parent (most common: comments.post_id → posts.id).
  const q = `
    select tc.table_schema as from_schema, tc.table_name as from_table,
           kcu.column_name as from_column,
           ccu.table_schema as to_schema, ccu.table_name as to_table,
           ccu.column_name as to_column
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name
       and tc.table_schema  = kcu.table_schema
      join information_schema.constraint_column_usage ccu
        on tc.constraint_name = ccu.constraint_name
       and tc.table_schema  = ccu.table_schema
     where tc.constraint_type = 'FOREIGN KEY'
       and (
         (tc.table_schema=$1 and tc.table_name=$2 and ccu.table_schema=$3 and ccu.table_name=$4)
         or
         (tc.table_schema=$3 and tc.table_name=$4 and ccu.table_schema=$1 and ccu.table_name=$2)
       )
     limit 1`;
  const r = await client.query(q, [child.schema, child.table, parent.schema, parent.table]);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  const edge: FkEdge = {
    fromSchema: row.from_schema, fromTable: row.from_table, fromColumn: row.from_column,
    toSchema:   row.to_schema,   toTable:   row.to_table,   toColumn:   row.to_column,
  };
  const direction: "child_to_parent" | "parent_to_child" =
    (edge.fromSchema === child.schema && edge.fromTable === child.table)
      ? "child_to_parent" : "parent_to_child";
  return { direction, edge };
}

/**
 * Expand embedded relations for a parent rowset. Runs one extra query
 * per relation (batched by IN clause), N+0 style — never per-row.
 */
export async function expandEmbeds(
  client: PoolClient,
  parentSchema: string,
  parentTable: string,
  parentRows: Record<string, unknown>[],
  nodes: SelectNode[],
): Promise<void> {
  if (parentRows.length === 0) return;
  for (const node of nodes) {
    if (!node.columns) continue; // scalar column
    const childSchema = "public"; // MVP: same schema
    const childTable  = node.name;
    if (!IDENT.test(childTable)) throw new Error(`invalid relation: ${childTable}`);
    const fk = await findFk(client, { schema: parentSchema, table: parentTable },
                                    { schema: childSchema,  table: childTable });
    if (!fk) throw new Error(`no foreign key between ${parentTable} and ${childTable}`);
    const cols = node.columns === "*"
      ? "*"
      : (node.columns as SelectNode[])
          .filter(n => !n.columns)
          .map(n => `"${n.name}"`).join(", ") || "*";

    if (fk.direction === "child_to_parent") {
      // child.fk → parent.pk. Attach parent row as object.
      const parentKey = fk.edge.toColumn;   // parent pk column
      const childFk   = fk.edge.fromColumn; // child fk column
      const ids = [...new Set(parentRows.map(r => r[parentKey]).filter(v => v != null))];
      if (ids.length === 0) { for (const r of parentRows) r[childTable] = []; continue; }
      const q = `select ${cols} from "${childSchema}"."${childTable}" where "${childFk}" = any($1)`;
      const res = await client.query(q, [ids]);
      const byKey = new Map<unknown, Record<string, unknown>[]>();
      for (const row of res.rows) {
        const k = row[childFk];
        const arr = byKey.get(k) ?? [];
        arr.push(row); byKey.set(k, arr);
      }
      for (const r of parentRows) r[childTable] = byKey.get(r[parentKey]) ?? [];
    } else {
      // parent.fk → child.pk. Attach as single object.
      const parentFk  = fk.edge.fromColumn; // parent fk column
      const childPk   = fk.edge.toColumn;   // child pk column
      const ids = [...new Set(parentRows.map(r => r[parentFk]).filter(v => v != null))];
      if (ids.length === 0) { for (const r of parentRows) r[childTable] = null; continue; }
      const q = `select ${cols} from "${childSchema}"."${childTable}" where "${childPk}" = any($1)`;
      const res = await client.query(q, [ids]);
      const byPk = new Map<unknown, Record<string, unknown>>();
      for (const row of res.rows) byPk.set(row[childPk], row);
      for (const r of parentRows) r[childTable] = byPk.get(r[parentFk]) ?? null;
    }
  }
}

/** Return the top-level scalar columns for building the parent SELECT. */
export function scalarColumns(nodes: SelectNode[]): string {
  const cols = nodes.filter(n => !n.columns).map(n => n.name);
  if (cols.length === 0) return "*";
  if (cols.includes("*")) return "*";
  return cols.map(c => `"${c}"`).join(", ");
}
