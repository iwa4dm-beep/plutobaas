-- Phase 15 · 0024 — Web Push + mobile push tokens + delivery log
-- Powers /push/v1/*.

create table if not exists admin.push_devices (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references admin.workspaces(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete cascade,
  platform      text not null check (platform in ('web','ios','android')),
  token         text not null,        -- FCM/APNs token or Web Push subscription JSON
  endpoint      text,                 -- for Web Push
  p256dh        text,                 -- for Web Push
  auth_secret   text,                 -- for Web Push
  user_agent    text,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (user_id, platform, token)
);
create index if not exists push_devices_ws_idx on admin.push_devices(workspace_id);
create index if not exists push_devices_user_idx on admin.push_devices(user_id);

create table if not exists admin.push_deliveries (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references admin.workspaces(id) on delete cascade,
  device_id     uuid references admin.push_devices(id) on delete set null,
  title         text,
  body          text,
  data          jsonb not null default '{}'::jsonb,
  status        text check (status in ('queued','sent','failed','expired')) default 'queued',
  error         text,
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists push_deliveries_ws_ts_idx on admin.push_deliveries(workspace_id, created_at desc);

grant select, insert, update, delete on admin.push_devices, admin.push_deliveries to authenticated;
grant all on admin.push_devices, admin.push_deliveries to service_role;

alter table admin.push_devices    enable row level security;
alter table admin.push_deliveries enable row level security;

drop policy if exists push_devices_own on admin.push_devices;
create policy push_devices_own on admin.push_devices for select to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from admin.workspace_members m
             where m.workspace_id = admin.push_devices.workspace_id and m.user_id = auth.uid()
               and m.role in ('owner','admin'))
);

drop policy if exists push_deliveries_read on admin.push_deliveries;
create policy push_deliveries_read on admin.push_deliveries for select to authenticated using (
  exists (select 1 from admin.workspace_members m
          where m.workspace_id = admin.push_deliveries.workspace_id and m.user_id = auth.uid())
);
