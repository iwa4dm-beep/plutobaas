-- Migration 0002 — optional sample seed for alice / bob
-- Schema version: 2
-- Only runs when STARTER_SEED=1 (see docker-compose). Idempotent.
-- Requires that alice+e2e@example.com and bob+e2e@example.com already exist
-- (create them via scripts/provision-test-users.mjs before applying).

do $$
declare
  a uuid;
  b uuid;
begin
  select id into a from auth.users where email = 'alice+e2e@example.com' limit 1;
  select id into b from auth.users where email = 'bob+e2e@example.com'   limit 1;

  if a is not null and not exists (select 1 from public.notes where user_id = a and body like 'seed:%') then
    insert into public.notes (user_id, body) values
      (a, 'seed: alice first note'),
      (a, 'seed: alice second note');
  end if;

  if b is not null and not exists (select 1 from public.notes where user_id = b and body like 'seed:%') then
    insert into public.notes (user_id, body) values
      (b, 'seed: bob first note');
  end if;
end $$;
