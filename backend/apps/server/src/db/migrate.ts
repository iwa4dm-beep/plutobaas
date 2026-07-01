// Runs pending SQL migrations against DATABASE_URL, mirroring the strategy the
// dashboard exposes (dry-run first, then apply, tracked in a ledger).
//
//   tsx src/db/migrate.ts             # apply pending
//   tsx src/db/migrate.ts --dry-run   # execute inside a transaction and roll back
//   tsx src/db/migrate.ts --plan      # list pending files without touching the DB
//
// Ledger table `_pluto_migrations` records name + sha256 + applied_at so we can
// detect drift (a file whose contents changed after being applied).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../config.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "migrations");

type Mode = "apply" | "dry-run" | "plan";

function parseMode(argv: string[]): Mode {
  if (argv.includes("--dry-run")) return "dry-run";
  if (argv.includes("--plan")) return "plan";
  return "apply";
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  await client.query(`
    create table if not exists _pluto_migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now(),
      duration_ms integer
    );
    alter table _pluto_migrations
      add column if not exists checksum text,
      add column if not exists duration_ms integer;
  `);

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Map<string, string>();
  const rows = await client.query<{ name: string; checksum: string | null }>(
    "select name, checksum from _pluto_migrations"
  );
  for (const r of rows.rows) applied.set(r.name, r.checksum ?? "");

  const pending: { name: string; sql: string; checksum: string }[] = [];
  const drift: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const cs = sha256(sql);
    if (!applied.has(file)) pending.push({ name: file, sql, checksum: cs });
    else if (applied.get(file) && applied.get(file) !== cs) drift.push(file);
  }

  if (drift.length) {
    console.warn(`⚠  checksum drift on already-applied migrations: ${drift.join(", ")}`);
    console.warn("    (edit new migrations instead of mutating history)");
  }

  console.log(`mode=${mode}  applied=${applied.size}  pending=${pending.length}`);
  if (mode === "plan" || !pending.length) {
    for (const p of pending) console.log(`  • ${p.name}  (${p.sql.length} bytes, sha ${p.checksum.slice(0, 10)}…)`);
    await client.end();
    return;
  }

  for (const p of pending) {
    const t0 = Date.now();
    console.log(`→ ${p.name}`);
    await client.query("begin");
    try {
      await client.query(p.sql);
      await client.query(
        "insert into _pluto_migrations(name, checksum, duration_ms) values ($1,$2,$3)",
        [p.name, p.checksum, Date.now() - t0]
      );
      if (mode === "dry-run") {
        await client.query("rollback");
        console.log(`  ✓ dry-run ok (${Date.now() - t0}ms) — rolled back`);
      } else {
        await client.query("commit");
        console.log(`  ✓ applied (${Date.now() - t0}ms)`);
      }
    } catch (e) {
      await client.query("rollback");
      console.error(`  ✗ FAILED: ${(e as Error).message}`);
      throw e;
    }
  }
  await client.end();
  console.log(mode === "dry-run" ? "✓ dry-run complete (no changes committed)" : "✓ migrations done");
}

main().catch((e) => { console.error(e); process.exit(1); });
