#!/usr/bin/env node
// Simple SQL migrations runner — applies files in ../../migrations/ in order.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = resolve(__dirname, '../../../migrations');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1 });

await sql`CREATE TABLE IF NOT EXISTS _pluto_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz DEFAULT now()
)`;

const applied = new Set((await sql`SELECT name FROM _pluto_migrations`).map((r) => r.name));
const files = (await readdir(MIG_DIR)).filter((f) => f.endsWith('.sql')).sort();

let ran = 0;
for (const f of files) {
  if (applied.has(f)) continue;
  console.log(`→ applying ${f}`);
  const contents = await readFile(join(MIG_DIR, f), 'utf8');
  await sql.begin(async (tx) => {
    await tx.unsafe(contents);
    await tx`INSERT INTO _pluto_migrations (name) VALUES (${f})`;
  });
  ran++;
}

console.log(ran === 0 ? '✔ no new migrations' : `✔ applied ${ran} migration(s)`);
await sql.end();
