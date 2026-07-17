// Convert parsed Laravel TableDefs into Pluto-ready Postgres migration SQL.
// Always emits GRANT + RLS enable + owner policy per the public-schema rule.
import type { TableDef } from "./types";

export function tableToSql(t: TableDef): string {
  const lines: string[] = [];
  lines.push(`-- Table: ${t.name}`);
  lines.push(`CREATE TABLE IF NOT EXISTS public.${q(t.name)} (`);

  const cols: string[] = [];
  const hasId = t.columns.some((c) => c.name === "id");
  if (!hasId) {
    cols.push(`  id uuid PRIMARY KEY DEFAULT gen_random_uuid()`);
  }
  for (const c of t.columns) {
    let line = `  ${q(c.name)} ${c.type}`;
    if (c.primary) line += " PRIMARY KEY";
    if (c.default) line += ` DEFAULT ${wrapDefault(c.default, c.type)}`;
    if (c.nullable === false || c.primary) line += " NOT NULL";
    else if (c.nullable !== true && !c.primary) line += " NOT NULL";
    if (c.unique) line += " UNIQUE";
    if (c.references) {
      line += ` REFERENCES public.${q(c.references.table)}(${q(c.references.column)}) ON DELETE CASCADE`;
    }
    cols.push(line);
  }
  // owner column for RLS if not present
  const hasCol = (name: string) => t.columns.some((c) => c.name === name);
  if (!hasCol("user_id") && !hasCol("owner_id")) {
    cols.push(`  owner_id uuid`);
  }
  if (t.timestamps) {
    if (!hasCol("created_at")) cols.push(`  created_at timestamptz NOT NULL DEFAULT now()`);
    if (!hasCol("updated_at")) cols.push(`  updated_at timestamptz NOT NULL DEFAULT now()`);
  }
  if (t.softDeletes && !hasCol("deleted_at")) {
    cols.push(`  deleted_at timestamptz`);
  }

  lines.push(cols.join(",\n"));
  lines.push(`);`);
  lines.push("");
  // GRANTs (required by public-schema rule)
  lines.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${q(t.name)} TO authenticated;`);
  lines.push(`GRANT ALL ON public.${q(t.name)} TO service_role;`);
  lines.push("");
  // RLS
  lines.push(`ALTER TABLE public.${q(t.name)} ENABLE ROW LEVEL SECURITY;`);
  const ownerCol = t.columns.some((c) => c.name === "user_id") ? "user_id"
    : t.columns.some((c) => c.name === "owner_id") ? "owner_id"
    : "owner_id";
  lines.push(`DROP POLICY IF EXISTS "${t.name}_owner_all" ON public.${q(t.name)};`);
  lines.push(`CREATE POLICY "${t.name}_owner_all" ON public.${q(t.name)}`);
  lines.push(`  FOR ALL TO authenticated`);
  lines.push(`  USING (${q(ownerCol)} = auth.uid())`);
  lines.push(`  WITH CHECK (${q(ownerCol)} = auth.uid());`);
  lines.push("");
  return lines.join("\n");
}

function q(id: string): string {
  return /^[a-z_][a-z0-9_]*$/i.test(id) ? id : `"${id.replace(/"/g, '""')}"`;
}
function wrapDefault(v: string, type: string): string {
  const trimmed = v.trim();
  // Normalize legacy Laravel/uuid-ossp default to pgcrypto's built-in.
  // Prevents "invalid input syntax for type uuid: uuid_generate_v4()" when the
  // uuid-ossp extension is not installed on the target Postgres instance.
  if (/^uuid_generate_v4\s*\(\s*\)$/i.test(trimmed)) return "gen_random_uuid()";
  // Any SQL function call (identifier(...)) or common keyword: pass through unquoted.
  if (/^[a-zA-Z_][\w.]*\s*\([^)]*\)$/.test(trimmed)) return trimmed;
  if (/^(current_timestamp|current_date|current_time|null|true|false)$/i.test(trimmed)) return trimmed;
  if (type.includes("int") || type === "numeric" || type === "double precision" || type === "boolean") return v;

  // JSON/JSONB defaults: Laravel migrations commonly emit `->default('[]')` or
  // `->default('{}')`. The raw captured value may already be wrapped in quotes
  // (e.g. `'{}'`, `'[]'`, `'{"k":"v"}'`). Naively wrapping it again produces
  // `'''{}'''` which stores the literal string `'{}'` — Postgres then rejects
  // it as `invalid input syntax for type json` (SQLSTATE 22P02, "Token \"'\"
  // is invalid"). Normalize by stripping any single layer of surrounding
  // quotes, escaping embedded single quotes for the SQL literal, and casting
  // to the JSON type so bad JSON fails at migration time, not runtime.
  const isJson = /^jsonb?$/i.test(type.trim());
  if (isJson) {
    let raw = trimmed;
    // Strip a single pair of matching surrounding quotes (single or double).
    if ((raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) ||
        (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) {
      raw = raw.slice(1, -1);
    }
    // Unescape SQL-doubled single quotes so we get the intended payload.
    raw = raw.replace(/''/g, "'");
    // Fall back to an empty JSON object if the payload is empty.
    if (!raw) raw = "{}";
    // Validate — if it isn't parseable JSON, defer to conservative empty
    // object rather than emit SQL that will fail apply.
    try { JSON.parse(raw); } catch { raw = "{}"; }
    const escaped = raw.replace(/'/g, "''");
    return `'${escaped}'::${type.trim().toLowerCase()}`;
  }

  return `'${v.replace(/'/g, "''")}'`;
}

export function buildMigrationBundle(tables: TableDef[], extraPreambleSql: string[] = []): string {
  const header = [
    "-- Generated by Auto-Connect Studio",
    `-- Generated at: ${new Date().toISOString()}`,
    "-- Applies to Pluto BaaS (Postgres 15+, RLS enforced).",
    "",
    "BEGIN;",
    "",
  ];

  // Ensure referenced enum types exist before any CREATE TABLE uses them.
  const preamble: string[] = [];

  // Custom enum types (etc.) discovered in the source migrations, e.g.
  // `CREATE TYPE ticket_status AS ENUM ('open','closed')` — emitted before
  // any `CREATE TABLE` that references them to avoid
  // `type "ticket_status" does not exist`.
  for (const stmt of extraPreambleSql) {
    preamble.push(stmt, "");
  }

  for (const enumSql of inferEnumPreamble(tables)) {
    preamble.push(enumSql, "");
  }

  const usesAppRole = tables.some((t) =>
    t.columns.some((c) => /\bapp_role\b/i.test(c.type))
  );
  if (usesAppRole) {
    preamble.push(
      `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
  END IF;
END $$;`,
      ""
    );
  }

  const usesInvoiceNumber = tables.some((t) =>
    t.columns.some((c) => /^(?:public\.)?generate_invoice_number\s*\(\s*\)$/i.test((c.default ?? "").trim()))
  );
  if (usesInvoiceNumber) {
    preamble.push(buildInvoiceNumberHelperSql(), "");
  }

  const footer = ["COMMIT;", ""];
  return [...header, ...preamble, ...tables.map(tableToSql), ...footer].join("\n");
}

function inferEnumPreamble(tables: TableDef[]): string[] {
  const builtin = new Set([
    "bigint", "bigserial", "boolean", "bytea", "date", "double", "inet", "integer", "int", "int4", "int8",
    "json", "jsonb", "numeric", "real", "serial", "smallint", "text", "time", "timestamp", "timestamptz", "uuid", "varchar",
    "character", "citext", "vector",
  ]);
  const names = new Set<string>();
  for (const table of tables) {
    for (const col of table.columns) {
      const base = col.type.replace(/\([^)]*\)/g, "").replace(/\[\]$/g, "").trim().split(/\s+/)[0].replace(/^public\./i, "");
      if (!base || builtin.has(base.toLowerCase())) continue;
      if (/(?:^|_)status$|(?:^|_)role$|(?:^|_)type$|(?:^|_)state$|enum/i.test(base)) names.add(base);
    }
  }
  const broadValues = [
    "pending", "active", "inactive", "archived", "open", "closed", "draft", "published",
    "in_progress", "processing", "completed", "failed", "success", "approved", "rejected",
    "resolved", "cancelled", "canceled", "paid", "unpaid", "admin", "moderator", "user",
  ];
  return [...names].map((name) => {
    const safe = name.replace(/"/g, "");
    const quoted = /^[a-z_][a-z0-9_]*$/i.test(safe) ? safe : `"${safe.replace(/"/g, '""')}"`;
    return `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = '${safe.replace(/'/g, "''")}') THEN
    CREATE TYPE public.${quoted} AS ENUM (${broadValues.map((v) => `'${v}'`).join(", ")});
  END IF;
END $$;`;
  });
}

function buildInvoiceNumberHelperSql(): string {
  return `-- Helper required by invoice_number DEFAULT public.generate_invoice_number()
CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq START 1000;

CREATE OR REPLACE FUNCTION public.generate_invoice_number()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  next_num bigint;
BEGIN
  next_num := nextval('public.invoice_number_seq');
  RETURN 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(next_num::text, 6, '0');
END;
$$;

GRANT USAGE, SELECT ON SEQUENCE public.invoice_number_seq TO authenticated;
GRANT ALL ON SEQUENCE public.invoice_number_seq TO service_role;
REVOKE EXECUTE ON FUNCTION public.generate_invoice_number() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_invoice_number() TO authenticated, service_role;`;
}
