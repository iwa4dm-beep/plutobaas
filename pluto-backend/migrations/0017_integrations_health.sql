-- Phase 15 · 0017 — Integrations health registry
-- Powers /admin/v1/integrations/health.

create table if not exists admin.integrations (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid references admin.workspaces(id) on delete cascade,
  kind           text not null,   -- 'smtp' | 'oauth' | 'webhook' | 'stripe' | 'ai_gateway' | ...
  name           text not null,
  config         jsonb not null default '{}'::jsonb,
  enabled        boolean not null default true,
  last_check_at  timestamptz,
  last_status    text check (last_status in ('ok','degraded','down','unknown')) default 'unknown',
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, kind, name)
);
create index if not exists integrations_ws_idx on admin.integrations(workspace_id);

grant select, insert, update, delete on admin.integrations to authenticated;
grant all on admin.integrations to service_role;
alter table admin.integrations enable row level security;

drop policy if exists integrations_read on admin.integrations;
create policy integrations_read on admin.integrations for select to authenticated using (
  workspace_id is null
  or exists (select 1 from admin.workspace_members m
             where m.workspace_id = integrations.workspace_id and m.user_id = auth.uid())
  or exists (select 1 from auth.users u where u.id = auth.uid() and u.is_superadmin)
);
