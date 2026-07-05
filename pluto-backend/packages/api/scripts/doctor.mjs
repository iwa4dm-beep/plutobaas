#!/usr/bin/env node
// pluto doctor — validates env, DB, JWT, S3, Redis reachability.
import postgres from 'postgres';

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const ok = (m) => console.log(`  ${GREEN}✔${RESET} ${m}`);
const fail = (m) => console.log(`  ${RED}✘${RESET} ${m}`);
const warn = (m) => console.log(`  ${YELLOW}⚠${RESET} ${m}`);

let failures = 0;

console.log('\n🩺 Pluto Doctor\n');

// 1. Required env vars
console.log(`${DIM}[1/4] Environment${RESET}`);
const required = ['DATABASE_URL', 'PLUTO_JWT_SECRET'];
for (const k of required) {
  if (!process.env[k]) { fail(`${k} missing`); failures++; }
  else ok(`${k} set`);
}
if (process.env.PLUTO_JWT_SECRET && process.env.PLUTO_JWT_SECRET.length < 32) {
  fail('PLUTO_JWT_SECRET too short (<32 chars)'); failures++;
}

// 2. Postgres
console.log(`\n${DIM}[2/4] Postgres${RESET}`);
if (process.env.DATABASE_URL) {
  try {
    const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 5 });
    const [row] = await sql`SELECT version() as v`;
    ok(`connected: ${row.v.split(',')[0]}`);
    const migRows = await sql`SELECT to_regclass('_pluto_migrations') as t`;
    if (migRows[0].t) ok('_pluto_migrations table present'); else warn('migrations not yet applied — run: pnpm migrate');
    await sql.end();
  } catch (e) { fail(`connect failed: ${e.message}`); failures++; }
}

// 3. Redis (optional)
console.log(`\n${DIM}[3/4] Redis (optional)${RESET}`);
if (process.env.REDIS_URL) {
  try {
    const { default: Redis } = await import('ioredis');
    const r = new Redis(process.env.REDIS_URL, { lazyConnect: true, connectTimeout: 3000 });
    await r.connect(); await r.ping();
    ok('reachable'); r.disconnect();
  } catch (e) { warn(`unreachable: ${e.message}`); }
} else warn('REDIS_URL not set (rate-limit will use in-memory store)');

// 4. S3 (optional)
console.log(`\n${DIM}[4/4] S3 / MinIO (optional)${RESET}`);
if (process.env.S3_ENDPOINT) ok(`endpoint: ${process.env.S3_ENDPOINT}`);
else warn('S3_ENDPOINT not set (storage service disabled)');

console.log(failures === 0 ? `\n${GREEN}✔ all checks passed${RESET}\n` : `\n${RED}✘ ${failures} check(s) failed${RESET}\n`);
process.exit(failures === 0 ? 0 : 1);
