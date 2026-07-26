#!/usr/bin/env node
/**
 * Provision two disposable test users via the Pluto Auth API.
 * Reads env from process.env (or examples/nextjs-starter/.env.local when run
 * from that directory via `node --env-file=.env.local scripts/provision-test-users.mjs`).
 *
 * Usage:
 *   node scripts/provision-test-users.mjs
 * Env:
 *   NEXT_PUBLIC_PLUTO_URL, NEXT_PUBLIC_PLUTO_ANON_KEY
 *   E2E_ALICE_EMAIL / E2E_ALICE_PASSWORD (defaults: alice+e2e / StrongPass!2026)
 *   E2E_BOB_EMAIL   / E2E_BOB_PASSWORD
 */
const URL = process.env.NEXT_PUBLIC_PLUTO_URL;
const ANON = process.env.NEXT_PUBLIC_PLUTO_ANON_KEY;
if (!URL || !ANON) {
  console.error("Missing NEXT_PUBLIC_PLUTO_URL or NEXT_PUBLIC_PLUTO_ANON_KEY.");
  process.exit(2);
}

const users = [
  {
    email: process.env.E2E_ALICE_EMAIL ?? "alice+e2e@example.com",
    password: process.env.E2E_ALICE_PASSWORD ?? "StrongPass!2026",
  },
  {
    email: process.env.E2E_BOB_EMAIL ?? "bob+e2e@example.com",
    password: process.env.E2E_BOB_PASSWORD ?? "StrongPass!2026",
  },
];

for (const u of users) {
  const res = await fetch(`${URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON },
    body: JSON.stringify(u),
  });
  const body = await res.text();
  if (res.ok) console.log(`✓ ${u.email}`);
  else if (/already|exists|registered/i.test(body)) console.log(`= ${u.email} (exists)`);
  else {
    console.error(`✗ ${u.email}: HTTP ${res.status} ${body}`);
    process.exitCode = 1;
  }
}
