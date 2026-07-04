-- Phase 51 — Realtime v4: presence CRDTs, offline queue, delta compression.
--
-- Tables
--   rt4_presence_state — LWW-Element-Set CRDT rows per (channel, actor).
--     Each write carries a Hybrid-Logical-Clock (hlc_ts, hlc_ctr, actor)
--     tuple that provides a total, monotone ordering across replicas.
--   rt4_offline_queue — per (channel, subscriber) durable buffer for
--     events emitted while the client was disconnected. Rows are consumed
--     on reconnect and pruned after ack or TTL.
--   rt4_delta_baseline — most recently acknowledged payload snapshot per
--     (channel, topic). Delta encoder computes JSON Patch (RFC 6902)
--     against this baseline; empty baseline ⇒ full payload.

create table if not exists public.rt4_presence_state (
  channel     text        not null,
  actor       text        not null,
  hlc_ts      bigint      not null,
  hlc_ctr     integer     not null,
  hlc_actor   text        not null,
  metadata    jsonb       not null default '{}'::jsonb,
  tombstone   boolean     not null default false,
  updated_at  timestamptz not null default now(),
  primary key (channel, actor)
);
create index if not exists rt4_presence_state_channel_idx
  on public.rt4_presence_state(channel, updated_at desc);

create table if not exists public.rt4_offline_queue (
  id           bigserial   primary key,
  channel      text        not null,
  subscriber   text        not null,
  seq          bigint      not null,
  event        text        not null,
  payload      jsonb       not null,
  is_delta     boolean     not null default false,
  base_hash    text,
  enqueued_at  timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index if not exists rt4_offline_queue_sub_idx
  on public.rt4_offline_queue(channel, subscriber, seq);
create index if not exists rt4_offline_queue_expiry_idx
  on public.rt4_offline_queue(expires_at);

create table if not exists public.rt4_delta_baseline (
  channel     text        not null,
  topic       text        not null,
  hash        text        not null,
  payload     jsonb       not null,
  updated_at  timestamptz not null default now(),
  primary key (channel, topic)
);

grant select, insert, update, delete on public.rt4_presence_state to authenticated;
grant select, insert, update, delete on public.rt4_offline_queue to authenticated;
grant select, insert, update, delete on public.rt4_delta_baseline to authenticated;
grant all on public.rt4_presence_state, public.rt4_offline_queue, public.rt4_delta_baseline to service_role;
grant usage, select on sequence public.rt4_offline_queue_id_seq to authenticated, service_role;

alter table public.rt4_presence_state enable row level security;
alter table public.rt4_offline_queue  enable row level security;
alter table public.rt4_delta_baseline enable row level security;

-- Realtime v4 tables are managed by the service role; authenticated users
-- interact via the plugin, which validates workspace/actor scope before
-- calling out. Deny direct client access by default.
create policy rt4_presence_service on public.rt4_presence_state
  for all to service_role using (true) with check (true);
create policy rt4_queue_service on public.rt4_offline_queue
  for all to service_role using (true) with check (true);
create policy rt4_baseline_service on public.rt4_delta_baseline
  for all to service_role using (true) with check (true);
