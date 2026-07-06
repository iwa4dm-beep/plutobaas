-- Phase 16 · 0028 — Onboarding: email queue, invites, demo seed
-- Powers /auth/v1/signup-full, /admin/v1/invite, /admin/v1/projects/:id/domains
-- and the SMTP queue worker.

create schema if not exists admin;

-- Async email queue — routes enqueue, worker sends every 10s.
create table if not exists admin.email_queue (
  id            uuid primary key default gen_random_uuid(),
  to_email      text not null,
  subject       text not null,
  html          text not null,
  template      text not null default 'generic',
  status        text not null default 'pending'
                check (status in ('pending','sending','sent','failed')),
  attempts      int  not null default 0,
  last_error    text,
  scheduled_at  timestamptz not null default now(),
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists email_queue_pending_idx
  on admin.email_queue(status, scheduled_at)
  where status in ('pending','failed');

grant select, insert, update on admin.email_queue to authenticated;
grant all on admin.email_queue to service_role;
alter table admin.email_queue enable row level security;

drop policy if exists email_queue_admin_only on admin.email_queue;
create policy email_queue_admin_only on admin.email_queue
  for select to authenticated using (
    exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin)
  );

-- Invite tokens — admin-generated single-use codes for new customers.
create table if not exists admin.invites (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  workspace_id   uuid references admin.workspaces(id) on delete cascade,
  project_id     uuid references admin.projects(id) on delete cascade,
  token_hash     text not null unique,
  invited_by     uuid references auth.users(id) on delete set null,
  expires_at     timestamptz not null,
  accepted_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists invites_email_idx on admin.invites(lower(email));

grant select, insert, update on admin.invites to authenticated;
grant all on admin.invites to service_role;
alter table admin.invites enable row level security;

drop policy if exists invites_admin_read on admin.invites;
create policy invites_admin_read on admin.invites
  for select to authenticated using (
    invited_by = auth.uid()
    or exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin)
  );

-- Demo data seeder — creates a `demo` schema per-project with sample tables.
-- Called from POST /auth/v1/signup-full.
create or replace function admin.seed_demo_data(_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  schema_name text := 'demo_' || replace(_project_id::text, '-', '');
begin
  execute format('create schema if not exists %I', schema_name);
  execute format($f$
    create table if not exists %I.customers (
      id serial primary key,
      name text not null,
      email text unique not null,
      created_at timestamptz default now()
    )
  $f$, schema_name);
  execute format($f$
    create table if not exists %I.orders (
      id serial primary key,
      customer_id int references %I.customers(id) on delete cascade,
      total numeric(10,2) not null,
      status text not null default 'pending',
      created_at timestamptz default now()
    )
  $f$, schema_name, schema_name);

  execute format($f$
    insert into %I.customers (name, email) values
      ('Alice Ahmed',   'alice@example.com'),
      ('Bilal Rahman',  'bilal@example.com'),
      ('Cathy Chen',    'cathy@example.com'),
      ('Dipa Das',      'dipa@example.com'),
      ('Emon Hasan',    'emon@example.com')
    on conflict (email) do nothing
  $f$, schema_name);

  execute format($f$
    insert into %I.orders (customer_id, total, status)
    select c.id, (random()*500 + 20)::numeric(10,2),
           (array['pending','paid','shipped','delivered'])[1 + floor(random()*4)::int]
    from %I.customers c
    on conflict do nothing
  $f$, schema_name, schema_name);

  execute format('grant usage on schema %I to authenticated, service_role', schema_name);
  execute format('grant select, insert, update, delete on all tables in schema %I to authenticated', schema_name);
  execute format('grant all on all tables in schema %I to service_role', schema_name);
  execute format('grant usage, select on all sequences in schema %I to authenticated, service_role', schema_name);
end;
$$;
