// Convert parsed Laravel TableDefs into Pluto-ready Postgres migration SQL.
// Always emits GRANT + RLS enable + owner policy per the public-schema rule.
import type { TableDef } from "./types";

export function tableToSql(t: TableDef): string {
  const lines: string[] = [];
  lines.push(`-- Table: ${t.name}`);
  lines.push(`CREATE TABLE IF NOT EXISTS public.${q(t.name)} (`);

  const cols: string[] = [];
  const hasId = t.columns.some((c) => c.name === "id");
  const hasExplicitPk = t.columns.some((c) => c.primary);
  if (!hasId && !hasExplicitPk) {
    cols.push(`  id uuid PRIMARY KEY DEFAULT gen_random_uuid()`);
  }
  let pkEmitted = !hasExplicitPk && !hasId ? true : false; // auto id already carries PK
  for (const c of t.columns) {
    let line = `  ${q(c.name)} ${c.type}`;
    if (c.primary && !pkEmitted) { line += " PRIMARY KEY"; pkEmitted = true; }
    if (c.default) {
      const d = wrapDefault(c.default, c.type);
      if (d !== null) line += ` DEFAULT ${d}`;
      else lines.push(`-- NOTE: dropped unsupported DEFAULT (${c.name}): ${c.default.replace(/\n/g, " ")}`);
    }
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
  const policyName = q(`${t.name}_owner_all`);
  lines.push(`DROP POLICY IF EXISTS ${policyName} ON public.${q(t.name)};`);
  lines.push(`CREATE POLICY ${policyName} ON public.${q(t.name)}`);
  lines.push(`  FOR ALL TO authenticated`);
  lines.push(`  USING (${q(ownerCol)} = auth.uid())`);
  lines.push(`  WITH CHECK (${q(ownerCol)} = auth.uid());`);
  lines.push("");
  return lines.join("\n");
}

function q(id: string): string {
  return /^[a-z_][a-z0-9_]*$/i.test(id) ? id : `"${id.replace(/"/g, '""')}"`;
}
function wrapDefault(v: string, type: string): string | null {
  const trimmed = v.trim();
  if (!trimmed) return null;

  // Normalize legacy Laravel/uuid-ossp default to pgcrypto's built-in.
  if (/^uuid_generate_v4\s*\(\s*\)$/i.test(trimmed)) return "gen_random_uuid()";

  // Whitelist of safe function-call defaults (no column references).
  const SAFE_FNS = /^(?:public\.)?(?:gen_random_uuid|now|current_timestamp|current_date|current_time|current_user|session_user|clock_timestamp|statement_timestamp|transaction_timestamp|localtimestamp|localtime|nextval|generate_invoice_number|uuid_generate_v[1-5])\s*\(/i;
  if (SAFE_FNS.test(trimmed) && /\)\s*(?:::[a-zA-Z_][\w]*)?$/.test(trimmed)) return trimmed;

  // SQL keywords (no parens).
  if (/^(current_timestamp|current_date|current_time|current_user|session_user|localtimestamp|localtime|null|true|false)$/i.test(trimmed)) return trimmed;

  const lowerType = type.trim().toLowerCase();
  const isNumeric = /\b(int|integer|bigint|smallint|serial|numeric|decimal|real|double precision|float)\b/.test(lowerType);
  const isBool = /^boolean$/.test(lowerType);

  // Numeric literal for numeric-ish columns.
  if (isNumeric && /^-?\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
  if (isBool && /^(0|1|true|false|'?t'?|'?f'?)$/i.test(trimmed)) {
    if (/^(1|true|'?t'?)$/i.test(trimmed)) return "true";
    return "false";
  }

  // JSON/JSONB / array defaults.
  const isJson = /^jsonb?$/i.test(lowerType);
  const isArray = /\[\]\s*$/.test(lowerType);
  if (isJson || isArray) {
    let raw = trimmed;
    if ((raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) ||
        (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2)) {
      raw = raw.slice(1, -1);
    }
    raw = raw.replace(/''/g, "'");
    if (!raw) raw = "{}";
    if (isJson) {
      try { JSON.parse(raw); } catch { raw = "{}"; }
    } else {
      if (!/^\{.*\}$/s.test(raw)) raw = "{}";
    }
    const escaped = raw.replace(/'/g, "''");
    return `'${escaped}'::${lowerType}`;
  }

  // Explicit quoted string literal — pass through with proper escaping.
  if (/^'.*'$/s.test(trimmed)) {
    const inner = trimmed.slice(1, -1).replace(/''/g, "'");
    return `'${inner.replace(/'/g, "''")}'`;
  }

  // Bare identifier or expression: to avoid Postgres treating it as a
  // column reference ("cannot use column reference in DEFAULT expression"),
  // treat it as a string literal only if the target type is text-like.
  // NOTE: previously this fell through to a broad `/^[a-z_]\w*$/` identifier
  // check, which matched non-text types like `boolean`, `jsonb`, `date`, etc.
  // and produced `DEFAULT 'BOOLEAN'` on boolean columns → Postgres 22P02
  // ("invalid input syntax for type boolean: \"BOOLEAN\"").
  const isTextLike =
    /^(text|citext|varchar|character\s+varying|character|char|nvarchar|varchar2|uuid|inet|cidr|macaddr|bytea|name|xml|ltree|tsvector|tsquery)\b/.test(lowerType) ||
    lowerType.startsWith('"') ||
    lowerType.endsWith("[]") && /^(text|varchar|char|uuid)/.test(lowerType);
  if (isTextLike) {
    return `'${trimmed.replace(/'/g, "''")}'`;
  }

  // For booleans: any non-standard token (e.g. bare `BOOLEAN`, `TRUE()`, …)
  // is unsafe — drop the DEFAULT rather than emit a broken literal.
  // For numeric/date/enum/other: also drop unknown bare identifiers.
  return null;
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
