// TypeScript codegen from a schema descriptor (see nested-writes.ts).
// Produces a minimal `.d.ts`-ready module for client SDKs.

import type { Schema } from "./nested-writes.js";

const PG_TS: Record<string, string> = {
  text: "string", varchar: "string", uuid: "string", citext: "string",
  int: "number", int4: "number", int8: "number", integer: "number", bigint: "number",
  numeric: "number", float4: "number", float8: "number", real: "number", "double precision": "number",
  bool: "boolean", boolean: "boolean",
  json: "unknown", jsonb: "unknown",
  timestamptz: "string", timestamp: "string", date: "string",
};

export type ColumnMeta = { name: string; type: string; nullable?: boolean };

export type SchemaWithTypes = Record<string, {
  table: string;
  columns_meta: ColumnMeta[];
  relations: Schema[string]["relations"];
  computed?: Array<{ name: string; ts_type: string }>;
}>;

export function generateTypes(schema: SchemaWithTypes): string {
  const lines: string[] = [
    "// AUTO-GENERATED — do not edit. Run `pluto types` to regenerate.",
    "// Source: /rest/v3/types",
    "",
  ];
  for (const [key, desc] of Object.entries(schema)) {
    const iface = pascal(desc.table);
    lines.push(`export interface ${iface} {`);
    for (const c of desc.columns_meta) {
      const ts = PG_TS[c.type.toLowerCase()] ?? "unknown";
      lines.push(`  ${c.name}${c.nullable ? "?" : ""}: ${ts}${c.nullable ? " | null" : ""};`);
    }
    for (const c of desc.computed ?? []) {
      lines.push(`  ${c.name}?: ${c.ts_type};`);
    }
    for (const [rname, rel] of Object.entries(desc.relations)) {
      const target = pascal(rel.target_table);
      const t = rel.kind === "has_many" ? `${target}[]` : `${target}`;
      lines.push(`  ${rname}?: ${t};`);
    }
    lines.push("}");
    lines.push("");
    lines.push(`export type ${iface}Insert = Partial<${iface}>;`);
    lines.push("");
    void key;
  }
  return lines.join("\n");
}

function pascal(s: string): string {
  return s.split(/[_\s-]+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}
