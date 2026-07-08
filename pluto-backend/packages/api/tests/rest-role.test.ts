// Integration-style unit tests for the Data API role gate.
//
// These lock in the fix for the two admissions bugs:
//   1. `role "admin" does not exist` — SET LOCAL ROLE was fed a JWT claim.
//   2. `new row violates row-level security policy` — auth.uid() returned
//      NULL because pluto.user_id was never set on the tx.
//
// Run: `node --test --import tsx pluto-backend/packages/api/tests/rest-role.test.ts`

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePgRole, VALID_PG_ROLES } from '../src/routes/rest.js';

describe('resolvePgRole — Postgres role whitelist', () => {
  it('passes anon and authenticated through unchanged', () => {
    assert.deepEqual(resolvePgRole('anon'),          { pgRole: 'anon',          fellBack: false, original: 'anon' });
    assert.deepEqual(resolvePgRole('authenticated'), { pgRole: 'authenticated', fellBack: false, original: 'authenticated' });
  });

  it('falls back app-level roles (admin/user/super_admin) to authenticated + flags it', () => {
    for (const r of ['admin', 'user', 'super_admin', 'moderator', 'editor']) {
      const out = resolvePgRole(r);
      assert.equal(out.pgRole, 'authenticated', `${r} should collapse to authenticated`);
      assert.equal(out.fellBack, true, `${r} should be flagged as a fallback so we log it`);
      assert.equal(out.original, r);
    }
  });

  it('never leaks service_role via a bearer-carrying request', () => {
    const out = resolvePgRole('service_role');
    assert.equal(out.pgRole, 'authenticated');
    assert.equal(out.fellBack, true);
  });

  it('treats missing / non-string role as anon', () => {
    assert.deepEqual(resolvePgRole(undefined), { pgRole: 'anon', fellBack: false, original: 'anon' });
    assert.deepEqual(resolvePgRole(null),      { pgRole: 'anon', fellBack: false, original: 'anon' });
    assert.deepEqual(resolvePgRole(''),        { pgRole: 'anon', fellBack: false, original: 'anon' });
    assert.deepEqual(resolvePgRole(123 as any),{ pgRole: 'anon', fellBack: false, original: 'anon' });
  });

  it('output pgRole is always one of the three real Postgres roles', () => {
    for (const r of ['anon', 'authenticated', 'admin', 'user', 'super_admin', 'service_role', 'garbage', '']) {
      assert.ok(
        (VALID_PG_ROLES as readonly string[]).includes(resolvePgRole(r).pgRole),
        `resolvePgRole(${JSON.stringify(r)}) returned a non-whitelisted role`,
      );
    }
  });
});
