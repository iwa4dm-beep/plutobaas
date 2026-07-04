// Phase 45 — Import resolver for npm: and https: specifiers.
//
// Mirrors the deno subhosting model:
//   * `npm:<pkg>@<ver>` → esm.sh CDN URL (bundled ESM with types).
//   * `https://...`     → passthrough, still cached + integrity-checked.
//   * everything else   → rejected (no bare specifiers).
//
// Resolutions are memoised in `fn_v4_imports` keyed on the raw specifier
// so a redeploy of the same bundle does not re-hit the CDN. Integrity is
// a sha384 hash of the fetched body, surfaced as a SRI-style string so
// deployments can pin exactly what shipped.

import { createHash } from "node:crypto";
import { db } from "../db/index.js";

const NPM_RE = /^npm:(@?[a-z0-9][a-z0-9._\-/]*?)(?:@([^/]+))?(\/.*)?$/i;

export type ResolvedImport = {
  specifier: string;
  resolved_url: string;
  integrity: string;
  size_bytes: number;
  from_cache: boolean;
};

async function fromCache(spec: string): Promise<ResolvedImport | null> {
  const row = await db.selectFrom("fn_v4_imports" as never).selectAll()
    .where("specifier" as never, "=", spec as never)
    .executeTakeFirst() as {
      resolved_url: string; integrity: string; size_bytes: string | number;
    } | undefined;
  if (!row) return null;
  return {
    specifier: spec,
    resolved_url: row.resolved_url,
    integrity:   row.integrity,
    size_bytes:  Number(row.size_bytes),
    from_cache:  true,
  };
}

async function saveCache(r: Omit<ResolvedImport, "from_cache">): Promise<void> {
  await db.insertInto("fn_v4_imports" as never).values({
    specifier: r.specifier, resolved_url: r.resolved_url,
    integrity: r.integrity, size_bytes: r.size_bytes,
  } as never).onConflict((c: unknown) =>
    (c as { column: (k: string) => { doUpdateSet: (u: unknown) => unknown } })
      .column("specifier").doUpdateSet({
        resolved_url: r.resolved_url, integrity: r.integrity, size_bytes: r.size_bytes,
      })).execute();
}

function toEsmShUrl(spec: string): string {
  const m = NPM_RE.exec(spec);
  if (!m) throw new Error(`invalid npm specifier: ${spec}`);
  const [, name, version, subpath] = m;
  const v = version ? `@${version}` : "";
  return `https://esm.sh/${name}${v}${subpath ?? ""}`;
}

export async function resolveImport(spec: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<ResolvedImport> {
  const cached = await fromCache(spec);
  if (cached) return cached;

  let url: string;
  if (spec.startsWith("npm:"))         url = toEsmShUrl(spec);
  else if (spec.startsWith("https://")) url = spec;
  else throw new Error(`unsupported specifier: ${spec} (use npm: or https:)`);

  const fetcher = opts.fetchImpl ?? fetch;
  const res = await fetcher(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`fetch_failed ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const integrity = "sha384-" + createHash("sha384").update(buf).digest("base64");

  const out = { specifier: spec, resolved_url: res.url || url, integrity, size_bytes: buf.length };
  await saveCache(out);
  return { ...out, from_cache: false };
}

/** Resolve every specifier in an import map in parallel. */
export async function resolveImportMap(map: Record<string, string>): Promise<Record<string, ResolvedImport>> {
  const entries = await Promise.all(
    Object.entries(map).map(async ([k, v]) => [k, await resolveImport(v)] as const)
  );
  return Object.fromEntries(entries);
}
