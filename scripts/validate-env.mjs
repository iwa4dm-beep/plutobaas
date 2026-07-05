#!/usr/bin/env node
// scripts/validate-env.mjs
// Preflight check: verifies required secrets, Postgres connectivity, JWT/JWKS
// availability, and upstream (Fastify /readyz) reachability. Prints a clear
// pass/fail report and exits non-zero on any failure.
//
// Usage:
//   node scripts/validate-env.mjs
//   PLUTO_UPSTREAM_URL=https://api.example.com node scripts/validate-env.mjs
//
// Optional deps: `pg` for Postgres check. Skipped gracefully if not installed.

const RESET = "\x1b[0m", RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", DIM = "\x1b[2m";
const results = [];
let failed = 0, warned = 0;

function record(name, status, detail) {
  results.push({ name, status, detail });
  if (status === "fail") failed++;
  if (status === "warn") warned++;
}

function need(name, { minLength = 0, urlLike = false } = {}) {
  const v = process.env[name];
  if (!v) return record(name, "fail", "missing");
  if (minLength && v.length < minLength) return record(name, "fail", `too short (< ${minLength} chars)`);
  if (urlLike) {
    try { new URL(v); } catch { return record(name, "fail", "not a valid URL"); }
  }
  record(name, "pass", `${v.length} chars`);
}

async function checkPostgres() {
  const url = process.env.DATABASE_URL;
  if (!url) return record("Postgres connectivity", "fail", "DATABASE_URL not set");
  let pg;
  try { pg = await import("pg"); } catch {
    return record("Postgres connectivity", "warn", "pg package not installed — skipping (npm i pg to enable)");
  }
  const client = new pg.default.Client({ connectionString: url, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    const r = await client.query("select version()");
    record("Postgres connectivity", "pass", r.rows[0].version.split(" ").slice(0, 2).join(" "));
  } catch (e) {
    record("Postgres connectivity", "fail", e.message);
  } finally { try { await client.end(); } catch {} }
}

async function checkUpstream() {
  const url = process.env.PLUTO_UPSTREAM_URL;
  if (!url) return record("Upstream reachability", "fail", "PLUTO_UPSTREAM_URL not set");
  const target = url.replace(/\/$/, "") + "/readyz";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(target, { signal: ctrl.signal });
    if (!res.ok) return record("Upstream reachability", "fail", `${target} → ${res.status}`);
    record("Upstream reachability", "pass", `${target} → ${res.status}`);
  } catch (e) {
    record("Upstream reachability", "fail", `${target} → ${e.message}`);
  } finally { clearTimeout(t); }
}

async function checkJwks() {
  const jwksUrl = process.env.JWKS_URL;
  if (!jwksUrl) return record("JWKS availability", "warn", "JWKS_URL not set — skipping (only needed if backend verifies external JWTs)");
  try {
    const res = await fetch(jwksUrl);
    if (!res.ok) return record("JWKS availability", "fail", `${jwksUrl} → ${res.status}`);
    const body = await res.json();
    const keys = Array.isArray(body.keys) ? body.keys.length : 0;
    if (!keys) return record("JWKS availability", "fail", "no keys in JWKS response");
    record("JWKS availability", "pass", `${keys} key(s)`);
  } catch (e) {
    record("JWKS availability", "fail", e.message);
  }
}

// --- run checks ---
need("PLUTO_JWT_SECRET", { minLength: 64 });
need("PLUTO_DB_PASSWORD", { minLength: 16 });
need("DATABASE_URL", { urlLike: true });
need("PLUTO_UPSTREAM_URL", { urlLike: true });

await checkPostgres();
await checkUpstream();
await checkJwks();

// --- print report ---
console.log("\nPluto preflight check\n" + "=".repeat(60));
for (const r of results) {
  const badge = r.status === "pass" ? `${GREEN}✓ PASS${RESET}` :
                r.status === "warn" ? `${YELLOW}⚠ WARN${RESET}` :
                                      `${RED}✗ FAIL${RESET}`;
  console.log(`${badge}  ${r.name.padEnd(28)} ${DIM}${r.detail}${RESET}`);
}
console.log("=".repeat(60));
console.log(`${results.length} checks · ${GREEN}${results.length - failed - warned} pass${RESET} · ${YELLOW}${warned} warn${RESET} · ${RED}${failed} fail${RESET}\n`);
process.exit(failed > 0 ? 1 : 0);
