#!/usr/bin/env -S npx tsx
// Smoke test: run the typed-client generator and verify the emitted
// TypeScript compiles.
//
//   PLUTO_SMOKE_URL / PLUTO_SMOKE_ANON_KEY set  →  fetch the live schema
//                                                  from /admin/v1/schema
//   otherwise                                    →  use a built-in fixture
//                                                  shaped like the real
//                                                  /admin/v1/schema payload.
//
// Then imports `generateTypedClient`, writes the output to a tempdir,
// runs `tsc --noEmit` on it, and exits non-zero on any error.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateTypedClient } from "../src/lib/pluto/gen-client";
import type { SchemaEndpoint, SchemaTable } from "../src/lib/pluto/live";

async function loadSchema(): Promise<{ tables: SchemaTable[]; endpoints: SchemaEndpoint[]; baseUrl: string }> {
  const url = process.env.PLUTO_SMOKE_URL;
  const key = process.env.PLUTO_SMOKE_ANON_KEY;
  if (url && key) {
    const res = await fetch(`${url.replace(/\/$/, "")}/admin/v1/schema`, { headers: { apikey: key } });
    if (!res.ok) throw new Error(`schema fetch failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { tables: SchemaTable[]; endpoints: SchemaEndpoint[] };
    return { ...data, baseUrl: url };
  }
  // Fixture — mirrors the shape returned by modules/admin/schema.ts.
  const tables: SchemaTable[] = [
    {
      schema: "public",
      name: "posts",
      columns: [
        { name: "id",         data_type: "uuid",   udt_name: "uuid", is_nullable: false, has_default: true,  is_primary_key: true,  is_unique: true,  references: null },
        { name: "title",      data_type: "text",   udt_name: "text", is_nullable: false, has_default: false, is_primary_key: false, is_unique: false, references: null },
        { name: "body",       data_type: "text",   udt_name: "text", is_nullable: true,  has_default: false, is_primary_key: false, is_unique: false, references: null },
        { name: "views",      data_type: "integer",udt_name: "int4", is_nullable: false, has_default: true,  is_primary_key: false, is_unique: false, references: null },
        { name: "published",  data_type: "boolean",udt_name: "bool", is_nullable: false, has_default: true,  is_primary_key: false, is_unique: false, references: null },
        { name: "created_at", data_type: "timestamp with time zone", udt_name: "timestamptz", is_nullable: false, has_default: true, is_primary_key: false, is_unique: false, references: null },
      ],
    },
    {
      schema: "public",
      name: "tag-list",           // deliberately non-identifier to test safeKey
      columns: [
        { name: "id",   data_type: "integer", udt_name: "int4", is_nullable: false, has_default: true,  is_primary_key: true,  is_unique: true,  references: null },
        { name: "name", data_type: "text",    udt_name: "text", is_nullable: false, has_default: false, is_primary_key: false, is_unique: true,  references: null },
      ],
    },
  ];
  const endpoints: SchemaEndpoint[] = [
    { table: "posts",    base: "/rest/v1/posts",    primary_key: ["id"], methods: ["GET","POST","PATCH","DELETE"] },
    { table: "tag-list", base: "/rest/v1/tag-list", primary_key: ["id"], methods: ["GET","POST","PATCH","DELETE"] },
  ];
  return { tables, endpoints, baseUrl: "http://localhost:8787" };
}

async function main() {
  const { tables, endpoints, baseUrl } = await loadSchema();
  if (tables.length === 0) throw new Error("no tables returned from schema — cannot smoke-test client gen");

  const src = generateTypedClient({ tables, endpoints, baseUrl });
  const dir = mkdtempSync(join(tmpdir(), "pluto-gen-"));
  const file = join(dir, "generated-client.ts");
  writeFileSync(file, src, "utf8");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "Bundler",
      strict: true, noEmit: true, skipLibCheck: true, lib: ["ES2022", "DOM"],
      types: [],
    },
    include: ["generated-client.ts"],
  }, null, 2));

  console.log(`[smoke] wrote ${file} (${src.length} bytes, ${tables.length} tables)`);

  // Storage module drift-check — the generator must always emit the
  // full Storage helper surface. If any of these names disappear the
  // frontend / SDK will silently lose functionality, so fail CI loudly.
  const STORAGE_METHODS = [
    "storage:",           // storage: { ... } block
    "upload:",            // single-shot upload
    "download:",          // streamed download
    "remove:",            // delete object
    "signedUrl:",         // mint short-lived signed URL
    "revokeSignedUrl:",   // revoke an issued grant
    "uploadLarge:",       // resumable / multipart upload
    "/storage/v1/object/",
    "/storage/v1/upload/init",
    "/storage/v1/upload/", // part PUT + complete + abort
    "/storage/v1/object/sign/",
  ];
  const missing = STORAGE_METHODS.filter((m) => !src.includes(m));
  if (missing.length) {
    console.error(`[smoke] FAIL — generated client is missing storage surface: ${missing.join(", ")}`);
    process.exit(2);
  }
  console.log(`[smoke] storage surface present (${STORAGE_METHODS.length} markers matched)`);

  const tsc = spawnSync("npx", ["--no-install", "tsc", "-p", dir], { stdio: "inherit", encoding: "utf8" });
  if (tsc.status !== 0) {
    console.error(`[smoke] tsc failed with exit ${tsc.status}`);
    process.exit(tsc.status ?? 1);
  }
  console.log("[smoke] OK — generated client typechecks cleanly (incl. storage helpers)");
}

main().catch((err) => { console.error(err); process.exit(1); });
