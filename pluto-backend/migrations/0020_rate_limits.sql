-- Phase 15 · 0020 — Rate-limit policies + usage counters
-- Powers /admin/v1/rate-limits.

create table if not exists admin.rate_limit_policies (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references admin.workspaces(id) on delete cascade,
  scope         text not null check (scope in ('global','ip','user','api_key','route')),
  match_value   text,                    -- route pattern, key prefix, etc.
  window_seconds integer not null default 60,
  max_requests  integer not null default 300,
  burst         integer not null default 0,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (workspace_id, scope, match_value)
);

create table if not exists admin.rate_limit_hits (
  bucket        text primary key,      -- '<policy_id>:<key>:<window_start>'
  policy_id     uuid references admin.rate_limit_policies(id) on delete cascade,
  count         integer not null default 0,
  window_start  timestamptz not null default now()
);
create index if not exists rl_hits_policy_idx on admin.rate_limit_hits(policy_id);

grant select, insert, update, delete on admin.rate_limit_policies to authenticated;
grant all on admin.rate_limit_policies, admin.rate_limit_hits to service_role;

alter table admin.rate_limit_policies enable row level security;

drop policy if exists rl_policies_read on admin.rate_limit_policies;
create policy rl_policies_read on admin.rate_limit_policies for select to authenticated using (
  workspace_id is null
  or exists (select 1 from admin.workspace_members m
             where m.workspace_id = rate_limit_policies.workspace_id and m.user_id = auth.uid())
  or exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin)
);
