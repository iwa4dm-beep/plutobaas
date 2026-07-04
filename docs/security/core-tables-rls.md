# Core tables: RLS & GRANT policy

_Applies to `public.users`, `public.buckets`, `public.objects`,
`public.refresh_tokens`, `public.oauth_accounts`._

## Decision

**RLS stays disabled** on the five core tables listed above, and only
`service_role` receives DML/DDL grants. The `authenticated` role is
**not** granted any privilege on these tables and cannot query them via
PostgREST / PgBouncer.

This is a deliberate deviation from the "RLS on everything" default and
must be preserved. Migration [`0008_rls_hardening.sql`](../../backend/apps/server/src/db/migrations/0008_rls_hardening.sql)
codifies it; migration [`0029_core_grants_lockdown.sql`](../../backend/apps/server/src/db/migrations/0029_core_grants_lockdown.sql)
adds the missing `REVOKE` + `GRANT` statements so the invariant is
enforced by the DB itself instead of relying on the app boundary.

## Why not RLS?

These tables are **not user-facing data**; they are the auth &
storage substrate of the platform:

| Table              | Reason RLS is a poor fit                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `users`            | Read from every login, workspace membership check, admin API. Row filter would fire before we know the caller's id.  |
| `refresh_tokens`   | Consumed by refresh flow using a hash lookup — RLS on `user_id` would need `SECURITY DEFINER` wrappers everywhere.   |
| `buckets`          | Bucket ACL is _explicit_ (`public`, `signed_urls`, etc.) and enforced in the storage plugin, not by row filters.     |
| `objects`          | Same as buckets; access decision is a function of the bucket ACL, the object path, and the caller's workspace scope. |
| `oauth_accounts`   | Linked from `users`; server-only maintenance surface.                                                                |

Layering RLS on top of the app-layer checks does not add defence in
depth — it only forces every internal Kysely/pg call to be wrapped in
`security definer` helpers, which _weakens_ auditability.

## What actually protects the data

1. **Network boundary** — the Postgres instance is not exposed publicly.
   Only the Fastify server (which connects as `service_role`) and
   internal migration tooling can reach the DB.
2. **Role separation at connect time** — every non-privileged connection
   uses the `authenticated` role via PostgREST. Because that role has
   `REVOKE ALL` on the five core tables, direct SELECTs return a
   permission error even if PostgREST were accidentally exposed.
3. **Application-layer authorization** — every route in
   `backend/apps/server/src/modules/**` runs through
   `requireApiKey` / `requireWorkspaceAdmin` / `requireScope(...)`
   before touching these tables.
4. **Audit logging** — mutations against `users`, `buckets`, and
   `refresh_tokens` emit `audit(...)` entries with actor + IP so
   privileged writes are always attributable.

## What must never change

- **Do not** grant `SELECT`/`INSERT`/`UPDATE`/`DELETE` on the five
  core tables to `authenticated`, `anon`, or any custom role that is
  reachable via PostgREST.
- **Do not** re-enable RLS without simultaneously adding policies for
  _every_ internal caller — otherwise the refresh-token flow, workspace
  membership check, and storage ACL evaluator will start silently
  returning empty result sets.
- **Do not** connect to Postgres from a client-side context with these
  credentials. Every DB call originates from a server function or
  Fastify handler.

## When to revisit

- If we expose direct PostgREST access for advanced users (BYO
  Supabase-compatible endpoint), each of the five tables must gain a
  RLS policy _before_ the corresponding `GRANT` is added.
- If a future feature needs `authenticated` users to read their own
  `users` row directly (rather than via `/auth/v1/me`), add:

  ```sql
  ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
  CREATE POLICY users_self_read ON public.users
    FOR SELECT TO authenticated USING (id = auth.uid());
  GRANT SELECT (id, email, role, created_at) ON public.users TO authenticated;
  ```

  Never grant the full column set — `password_hash` must stay server-only.

## References

- `backend/apps/server/src/db/migrations/0001_init.sql` — original DDL.
- `backend/apps/server/src/db/migrations/0008_rls_hardening.sql` — disables RLS with rationale.
- `backend/apps/server/src/db/migrations/0029_core_grants_lockdown.sql` — REVOKE from `authenticated`/`anon`, GRANT to `service_role`.
- `backend/apps/server/src/lib/apikey.ts` — the app-layer gate every route passes through.
