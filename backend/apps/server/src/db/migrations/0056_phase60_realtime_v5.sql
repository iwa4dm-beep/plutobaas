-- Phase 60 — Realtime v5 (presence shards, room delivery ledger).

create table if not exists public.realtime_v5_presence (
  workspace_id  uuid not null,
  room          text not null,
  user_id       uuid not null,
  shard         int  not null,
  status        text not null,
  meta          jsonb,
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, room, user_id)
);
create index if not exists idx_rtv5_presence_shard on public.realtime_v5_presence(shard, workspace_id);
grant select, insert, update, delete on public.realtime_v5_presence to authenticated;
grant all on public.realtime_v5_presence to service_role;
alter table public.realtime_v5_presence enable row level security;

create table if not exists public.realtime_v5_room_seq (
  workspace_id  uuid not null,
  room          text not null,
  last_seq      bigint not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, room)
);
grant select, insert, update on public.realtime_v5_room_seq to authenticated;
grant all on public.realtime_v5_room_seq to service_role;
alter table public.realtime_v5_room_seq enable row level security;
