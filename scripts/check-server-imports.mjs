#!/usr/bin/env node
/**
 * Build-time guard: `@tanstack/react-start/server` (and other server-only
 * runtime modules) may only be imported from files that can never reach a
 * client bundle — i.e. `*.server.ts(x)` modules and the SSR entry.
 *
 * Any other file under src/ is potentially reachable from a client route via
 * routeTree.gen.ts, and such an import produces the Vite
 * "[import-protection] Import denied in client environment" 500 + blank page.
 *
 * Run: node scripts/check-server-imports.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const FORBIDDEN = [
  "@tanstack/react-start/server",
  "node:async_hooks",
  "node:fs",
  "node:child_process",
];

/** Files allowed to import the modules above. */
const ALLOWED = [
  /\.server\.[cm]?tsx?$/,
  /^src[\\/]server\.ts$/,
  /^src[\\/]routes[\\/]api[\\/]/,
  /^scripts[\\/]/,
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.[cm]?tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (ALLOWED.some((re) => re.test(rel))) continue;
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    // Only static imports/re-exports matter for bundling; dynamic import()
    // of a *.server module is the sanctioned escape hatch.
    const m = line.match(/^\s*(?:import|export)\s[^;]*from\s*["']([^"']+)["']/);
    const bare = line.match(/^\s*import\s*["']([^"']+)["']/);
    const spec = m?.[1] ?? bare?.[1];
    if (!spec) return;
    if (FORBIDDEN.includes(spec) || /\.server(\.[cm]?tsx?)?$/.test(spec)) {
      violations.push(`${rel}:${i + 1}  imports "${spec}"`);
    }
  });
}

if (violations.length) {
  console.error(
    "\n[check-server-imports] Server-only imports found in client-reachable files:\n",
  );
  for (const v of violations) console.error("  ✗ " + v);
  console.error(
    "\nFix: move the logic into a `*.server.ts` module and expose it through a\n" +
      "`createServerOnlyFn` wrapper (see src/lib/pluto/request-context.ts).\n",
  );
  process.exit(1);
}

console.log("[check-server-imports] OK — no server-only imports in client-reachable files.");
