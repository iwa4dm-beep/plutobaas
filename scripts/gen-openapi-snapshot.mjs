#!/usr/bin/env node
// OpenAPI snapshot generator.
//
// Boots against a running Pluto server (or uses PLUTO_URL) and writes
// docs/api/openapi.snapshot.json. The CI job then runs
// `git diff --exit-code docs/api/openapi.snapshot.json` — an
// unaccounted-for schema drift fails the build. When a migration
// intentionally changes the surface, developers run
// `npm run openapi:snapshot` locally and commit the diff.
//
// Snapshot post-processing:
//   • drop the `servers` array (host varies per environment)
//   • pretty-print with 2-space indent + sorted top-level `paths` keys
//     so diffs read as content changes, not reorderings

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const url = process.env.PLUTO_URL || "http://localhost:8080";
const apikey = process.env.PLUTO_ANON_KEY || process.env.ANON_KEY || "pk_anon_ci";
const dest = process.env.SNAPSHOT_OUT || resolve(process.cwd(), "docs/api/openapi.snapshot.json");

async function main() {
  const res = await fetch(`${url}/admin/v1/schema/openapi.json`, {
    headers: { apikey, authorization: `Bearer ${process.env.SERVICE_ROLE_KEY ?? apikey}` },
  });
  if (!res.ok) {
    console.error(`openapi fetch failed: ${res.status} ${await res.text().catch(() => "")}`);
    process.exit(2);
  }
  const doc = await res.json();
  delete doc.servers;
  const paths = doc.paths ?? {};
  const sortedPaths = Object.fromEntries(Object.keys(paths).sort().map((k) => [k, paths[k]]));
  doc.paths = sortedPaths;
  const out = JSON.stringify(doc, null, 2) + "\n";
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);
  console.log(`wrote ${dest} (${out.length} bytes, ${Object.keys(sortedPaths).length} paths)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
