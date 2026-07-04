-- Phase 48 — Broadcast/Presence v2 (WebSocket fan-out, presence sync, ephemeral broadcast)
-- Redis is preferred at runtime; these tables are the durable fallback so
-- session/presence still work in single-instance and no-Redis deployments.

-- WebSocket sessions attached to this cluster. Rows are pruned when
-- last_seen_at falls behind the heartbeat window.
create table if not exists public.bp_sessions (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid,
  user_id        uuid,
  instance_id    text not null,               -- server hostname / pod id
  client_meta    jsonb not null default '{}'::jsonb,
  connected_at   timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create index if not exists bp_sessions_ws_idx  on public.bp_sessions(workspace_id);
create index if not exists bp_sessions_seen_idx on public.bp_sessions(last_seen_at);

grant select, insert, update, delete on public.bp_sessions to authenticated;
grant all on public.bp_sessions to service_role;
alter table public.bp_sessions enable row level security;
create policy bp_sessions_owner on public.bp_sessions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Presence membership per (channel, session). A user with N tabs has N rows.
-- expires_at drives the TTL sweeper so half-open sockets don't linger.
create table if not exists public.bp_presence (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid,
  channel        text not null,
  session_id     uuid not null references public.bp_sessions(id) on delete cascade,
  user_id        uuid,
  state          jsonb not null default '{}'::jsonb,
  joined_at      timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '60 seconds',
  unique (channel, session_id)
);
create index if not exists bp_presence_channel_idx on public.bp_presence(channel);
create index if not exists bp_presence_exp_idx     on public.bp_presence(expires_at);

grant select, insert, update, delete on public.bp_presence to authenticated;
grant all on public.bp_presence to service_role;
alter table public.bp_presence enable row level security;
create policy bp_presence_owner on public.bp_presence
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Ephemeral broadcast log. Rows are purged past expires_at. Persisted so
-- (a) reconnecting clients can replay recent messages within the TTL, and
-- (b) load tests can verify fan-out ordering deterministically.
create table if not exists public.bp_broadcasts (
  seq            bigserial primary key,       -- global monotonic order per channel
  workspace_id   uuid,
  channel        text not null,
  event          text not null,
  payload        jsonb not null default '{}'::jsonb,
  sender_id      uuid,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);
create index if not exists bp_broadcasts_ch_seq_idx on public.bp_broadcasts(channel, seq);
create index if not exists bp_broadcasts_exp_idx    on public.bp_broadcasts(expires_at);

grant select, insert on public.bp_broadcasts to authenticated;
grant all on public.bp_broadcasts to service_role;
alter table public.bp_broadcasts enable row level security;
create policy bp_broadcasts_read on public.bp_broadcasts
  for select to authenticated using (true);
create policy bp_broadcasts_write on public.bp_broadcasts
  for insert to authenticated with check (sender_id = auth.uid() or sender_id is null);
