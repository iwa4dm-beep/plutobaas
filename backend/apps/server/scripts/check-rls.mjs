#!/usr/bin/env node
// RLS / workspace-scope regression check.
//
// Statically scans every SQL migration under src/db/migrations to
// verify that every table created in the `public` schema either:
//
//   (a) opts out via a marker comment `-- @rls-exempt: <reason>` on
//       the line immediately preceding `create table`, OR
//   (b) has both `alter table … enable row level security` AND at
//       least one `create policy … on <table>` in the same repo, AND
//   (c) if `workspace_id` is one of the columns → at least one policy
//       on that table references `workspace_id` (so a stray policy
//       like `using (true)` doesn't get a pass).
//
// Exits non-zero on any violation so CI can fail the build.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "src", "db", "migrations");

// Roll every migration into one text blob so we can reason about the
// final desired state (e.g. RLS enabled in a later file for a table
// created earlier).
const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const perFile = files.map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));
const combined = perFile.map((p) => p.sql).join("\n\n");

// --- Discover tables created in public with their column list --------
const CREATE_RE = /create\s+table(?:\s+if\s+not\s+exists)?\s+public\.([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)^\s*\)\s*;/gim;
const tables = [];
for (const p of perFile) {
  CREATE_RE.lastIndex = 0;
  let m;
  while ((m = CREATE_RE.exec(p.sql)) !== null) {
    const name = m[1];
    const body = m[2];
    const columns = [...body.matchAll(/^\s*([a-z_][a-z0-9_]*)\s+[a-z]/gmi)].map((x) => x[1].toLowerCase());
    const preceding = p.sql.slice(Math.max(0, m.index - 400), m.index);
    const ex = /--\s*@rls-exempt:\s*(.+)$/im.exec(preceding);
    tables.push({ name, file: p.file, columns, exempt: ex ? ex[1].trim() : null });
  }
}

// --- Collect alter-table RLS enables and create-policy statements ----
const rlsEnabled = new Set();
for (const m of combined.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?public\.([a-z_][a-z0-9_]*)\s+enable\s+row\s+level\s+security/gi)) {
  rlsEnabled.add(m[1]);
}

const policies = [];
const POLICY_RE = /create\s+policy\s+([a-z_][a-z0-9_]*)\s+on\s+public\.([a-z_][a-z0-9_]*)([\s\S]*?);/gi;
for (const m of combined.matchAll(POLICY_RE)) {
  policies.push({ name: m[1], table: m[2], body: m[3] });
}
const policiesByTable = new Map();
for (const p of policies) {
  if (!policiesByTable.has(p.table)) policiesByTable.set(p.table, []);
  policiesByTable.get(p.table).push(p);
}

// --- Enforce rules ---------------------------------------------------
const violations = [];
for (const t of tables) {
  if (t.exempt) continue;
  if (!rlsEnabled.has(t.name)) {
    violations.push(`${t.file}:${t.name}: RLS not enabled (add \`alter table public.${t.name} enable row level security\` or mark \`-- @rls-exempt: <reason>\`)`);
    continue;
  }
  const pols = policiesByTable.get(t.name) ?? [];
  if (pols.length === 0) {
    violations.push(`${t.file}:${t.name}: RLS enabled but no policies exist — no role can read the table`);
    continue;
  }
  if (t.columns.includes("workspace_id")) {
    const hasWorkspaceFilter = pols.some((p) => /workspace_id/i.test(p.body) || /is_workspace_member/i.test(p.body) || /current_workspace_id/i.test(p.body));
    if (!hasWorkspaceFilter) {
      violations.push(`${t.file}:${t.name}: has workspace_id but no policy references workspace_id / is_workspace_member() — cross-tenant leak risk`);
    }
  }
}

if (violations.length > 0) {
  console.error(`\n❌ RLS regression check failed — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error("  - " + v);
  console.error("\nAdd RLS policies or mark the table as exempt with `-- @rls-exempt: <reason>` on the line above `create table`.\n");
  process.exit(1);
}

console.log(`✅ RLS regression check passed for ${tables.length} table(s) in ${files.length} migration(s).`);
if (process.env.PLUTO_RLS_REPORT === "1") {
  for (const t of tables) {
    const pols = policiesByTable.get(t.name) ?? [];
    console.log(`  ${t.name.padEnd(28)} rls=${rlsEnabled.has(t.name)} policies=${pols.length} ws=${t.columns.includes("workspace_id")}`);
  }
}
