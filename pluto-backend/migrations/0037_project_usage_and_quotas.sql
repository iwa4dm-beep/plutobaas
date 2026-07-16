-- 0037_project_usage_and_quotas.sql
-- Phase F — per-project traffic accounting, quotas, and abuse controls.
--
-- Everything here is additive and idempotent. RLS scopes reads to workspace
-- members; writes are service-role only (populated by the log parser).

create schema if not exists admin;
create extension if not exists citext;

-- =========================================================================
-- 1. Daily traffic rollups per slug.
--    Populated by pluto-backend/deploy/parse-nginx-logs.sh (systemd timer).
-- =========================================================================
create table if not exists admin.project_usage (
  slug          citext       not null,
  day           date         not null,
  requests      bigint       not null default 0,
  bytes_out     bigint       not null default 0,
  errors_4xx    bigint       not null default 0,
  errors_5xx    bigint       not null default 0,
  updated_at    timestamptz  not null default now(),
  primary key (slug, day)
);

create index if not exists project_usage_day_idx on admin.project_usage (day desc);

grant select on admin.project_usage to authenticated;
grant all    on admin.project_usage to service_role;

alter table admin.project_usage enable row level security;

-- Members of the workspace that owns <slug> can read their own usage.
-- Reuses public.workspaces(slug) added in migration 0034.
drop policy if exists project_usage_read on admin.project_usage;
create policy project_usage_read on admin.project_usage
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.workspaces w
      join public.workspace_members m on m.workspace_id = w.id
      where w.slug = admin.project_usage.slug
        and m.user_id = auth.uid()
    )
  );

-- =========================================================================
-- 2. Per-project quotas + limit state.
--    NULL = use defaults from admin.quota_defaults.
-- =========================================================================
create table if not exists admin.project_quotas (
  slug                     citext primary key,
  monthly_request_limit    bigint,
  monthly_bytes_limit      bigint,
  rate_limit_rps           integer,
  rate_limit_burst         integer,
  suspended                boolean     not null default false,
  suspended_reason         text,
  updated_at               timestamptz not null default now()
);

grant select on admin.project_quotas to authenticated;
grant all    on admin.project_quotas to service_role;

alter table admin.project_quotas enable row level security;

drop policy if exists project_quotas_read on admin.project_quotas;
create policy project_quotas_read on admin.project_quotas
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.workspaces w
      join public.workspace_members m on m.workspace_id = w.id
      where w.slug = admin.project_quotas.slug
        and m.user_id = auth.uid()
    )
  );

create table if not exists admin.quota_defaults (
  id                       int primary key default 1 check (id = 1),
  monthly_request_limit    bigint  not null default 1000000,
  monthly_bytes_limit      bigint  not null default 10737418240,   -- 10 GiB
  rate_limit_rps           integer not null default 20,
  rate_limit_burst         integer not null default 40
);
insert into admin.quota_defaults (id) values (1) on conflict do nothing;

grant select on admin.quota_defaults to authenticated;
grant all    on admin.quota_defaults to service_role;

-- =========================================================================
-- 3. Abuse events — populated by the log parser when a slug crosses a
--    threshold (429 storm, 4xx spike, bytes overrun). Surfaced in the
--    dashboard so operators can investigate.
-- =========================================================================
create table if not exists admin.abuse_events (
  id           uuid        primary key default gen_random_uuid(),
  slug         citext      not null,
  kind         text        not null check (kind in ('rate_spike','error_spike','bytes_overrun','request_overrun','manual')),
  detail       jsonb       not null default '{}'::jsonb,
  observed_at  timestamptz not null default now()
);

create index if not exists abuse_events_slug_idx on admin.abuse_events (slug, observed_at desc);

grant select on admin.abuse_events to authenticated;
grant all    on admin.abuse_events to service_role;

alter table admin.abuse_events enable row level security;

drop policy if exists abuse_events_read on admin.abuse_events;
create policy abuse_events_read on admin.abuse_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.workspaces w
      join public.workspace_members m on m.workspace_id = w.id
      where w.slug = admin.abuse_events.slug
        and m.user_id = auth.uid()
    )
  );

-- =========================================================================
-- 4. Convenience view — current-month totals + effective quotas.
-- =========================================================================
create or replace view admin.project_usage_current_month as
select
  u.slug,
  sum(u.requests)              as requests,
  sum(u.bytes_out)             as bytes_out,
  sum(u.errors_4xx)            as errors_4xx,
  sum(u.errors_5xx)            as errors_5xx,
  coalesce(q.monthly_request_limit, d.monthly_request_limit) as request_limit,
  coalesce(q.monthly_bytes_limit,   d.monthly_bytes_limit)   as bytes_limit,
  coalesce(q.suspended, false)                                as suspended
from admin.project_usage u
left join admin.project_quotas q on q.slug = u.slug
cross join admin.quota_defaults d
where u.day >= date_trunc('month', now())::date
group by u.slug, q.monthly_request_limit, q.monthly_bytes_limit, q.suspended,
         d.monthly_request_limit, d.monthly_bytes_limit;

grant select on admin.project_usage_current_month to authenticated;
