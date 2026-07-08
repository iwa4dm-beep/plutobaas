// Pure helper — kept in its own module so unit tests don't have to pull in
// the postgres.js driver via ../db/pool.
//
// Only three Postgres roles are valid on the Data API path. Application-level
// roles (admin/user/super_admin) live in JWT claims and are enforced by RLS
// via auth.uid() / request.jwt.claims — never as a Postgres role. Anything
// outside the allowlist collapses to `authenticated` and is flagged so the
// caller can log the fallback.

export const VALID_PG_ROLES = ['anon', 'authenticated', 'service_role'] as const;
export type PgRole = typeof VALID_PG_ROLES[number];

export function resolvePgRole(jwtRole: unknown): { pgRole: PgRole; fellBack: boolean; original: string } {
  const original = typeof jwtRole === 'string' && jwtRole.length > 0 ? jwtRole : 'anon';
  if (original === 'anon') return { pgRole: 'anon', fellBack: false, original };
  if (original === 'authenticated') return { pgRole: 'authenticated', fellBack: false, original };
  // service_role must never be reachable via a public bearer token — collapse.
  return { pgRole: 'authenticated', fellBack: true, original };
}
