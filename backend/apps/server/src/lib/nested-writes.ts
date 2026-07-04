// Nested-write planner.
//
// Given a payload like:
//   { title: "Post", author: { name: "u" }, tags: [{ label: "a" }] }
// and a schema descriptor with foreign-key relations, produce an ordered
// list of pure INSERT operations that satisfy referential integrity:
//
//   1. insert author (parent)  → returns id
//   2. insert post (child)     → uses author.id
//   3. insert tags (child rows) → uses post.id
//
// The planner is deterministic and side-effect free — callers execute the
// resulting steps inside a single transaction and thread returned IDs
// forward through the `parent_ref` slot.

export type RelationKind = "belongs_to" | "has_many";

export type Relation = {
  name: string;                // key in the payload
  kind: RelationKind;
  target_table: string;
  local_column: string;        // FK column on this side
  target_column: string;       // referenced column on the other side (usually "id")
};

export type TableDescriptor = {
  table: string;
  columns: string[];
  relations: Record<string, Relation>;
};

export type Schema = Record<string, TableDescriptor>;

export type WriteStep = {
  op: "insert";
  table: string;
  columns: Record<string, unknown>;
  // Placeholder references filled after a prior step runs.
  refs?: Array<{ column: string; from_step: number; from_column: string }>;
  // Label used only for debugging.
  label: string;
};

export type Plan = { steps: WriteStep[]; root_step: number };

export function planNestedInsert(schema: Schema, rootTable: string, payload: Record<string, unknown>): Plan {
  const steps: WriteStep[] = [];

  function scalarsFor(table: string, obj: Record<string, unknown>): Record<string, unknown> {
    const desc = schema[table];
    if (!desc) throw new Error(`unknown_table:${table}`);
    const out: Record<string, unknown> = {};
    for (const c of desc.columns) if (obj[c] !== undefined) out[c] = obj[c];
    return out;
  }

  function planNode(table: string, node: Record<string, unknown>, label: string): number {
    const desc = schema[table];
    if (!desc) throw new Error(`unknown_table:${table}`);

    // 1) Plan belongs_to parents first so we know their IDs.
    const parentRefs: Array<{ column: string; from_step: number; from_column: string }> = [];
    for (const [key, rel] of Object.entries(desc.relations)) {
      if (rel.kind !== "belongs_to") continue;
      const nested = node[key];
      if (nested == null) continue;
      if (typeof nested !== "object" || Array.isArray(nested)) throw new Error(`bad_belongs_to:${key}`);
      const parentIdx = planNode(rel.target_table, nested as Record<string, unknown>, `${label}.${key}`);
      parentRefs.push({ column: rel.local_column, from_step: parentIdx, from_column: rel.target_column });
    }

    // 2) Insert self.
    const selfIdx = steps.length;
    steps.push({
      op: "insert",
      table,
      columns: scalarsFor(table, node),
      refs: parentRefs.length ? parentRefs : undefined,
      label,
    });

    // 3) Plan has_many children after self so they can bind to our id.
    for (const [key, rel] of Object.entries(desc.relations)) {
      if (rel.kind !== "has_many") continue;
      const nested = node[key];
      if (nested == null) continue;
      if (!Array.isArray(nested)) throw new Error(`bad_has_many:${key}`);
      for (const [i, child] of nested.entries()) {
        if (typeof child !== "object" || child === null || Array.isArray(child)) {
          throw new Error(`bad_has_many_item:${key}[${i}]`);
        }
        const childIdx = steps.length;
        steps.push({
          op: "insert",
          table: rel.target_table,
          columns: scalarsFor(rel.target_table, child as Record<string, unknown>),
          refs: [{ column: rel.local_column, from_step: selfIdx, from_column: rel.target_column }],
          label: `${label}.${key}[${i}]`,
        });
        // Recurse into deeper children by re-planning belongs_to/has_many on this child.
        const grand = planNode(rel.target_table, { ...(child as Record<string, unknown>), __skip_self: true }, `${label}.${key}[${i}]`);
        // planNode always emits a new self insert; the recursion above already inserted
        // the child, so discard the duplicate self step and re-parent its descendants.
        steps.splice(grand, 1);
      }
    }

    return selfIdx;
  }

  const rootIdx = planNode(rootTable, payload, rootTable);
  return { steps, root_step: rootIdx };
}
