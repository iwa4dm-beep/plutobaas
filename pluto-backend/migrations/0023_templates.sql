-- Phase 15 · 0023 — Email + notification templates
-- Powers /templates/v1.

create table if not exists admin.templates (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references admin.workspaces(id) on delete cascade,
  slug          text not null,
  channel       text not null check (channel in ('email','sms','push','webhook')),
  subject       text,
  body_html     text,
  body_text     text,
  variables     jsonb not null default '[]'::jsonb,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, slug, channel)
);
create index if not exists templates_ws_idx on admin.templates(workspace_id);

grant select, insert, update, delete on admin.templates to authenticated;
grant all on admin.templates to service_role;
alter table admin.templates enable row level security;

drop policy if exists templates_read on admin.templates;
create policy templates_read on admin.templates for select to authenticated using (
  workspace_id is null
  or exists (select 1 from admin.workspace_members m
             where m.workspace_id = admin.templates.workspace_id and m.user_id = auth.uid())
);

-- Seed built-in transactional templates (workspace_id = null → global defaults).
insert into admin.templates (workspace_id, slug, channel, subject, body_html, body_text, variables)
values
  (null, 'auth.verify_email',    'email', 'Verify your email',   '<p>Click <a href="{{link}}">here</a> to verify.</p>', 'Verify: {{link}}', '["link"]'::jsonb),
  (null, 'auth.reset_password',  'email', 'Reset your password', '<p>Reset link: <a href="{{link}}">{{link}}</a></p>',   'Reset: {{link}}',  '["link"]'::jsonb),
  (null, 'auth.magic_link',      'email', 'Your sign-in link',   '<p>Sign in: <a href="{{link}}">{{link}}</a></p>',      'Sign in: {{link}}','["link"]'::jsonb)
on conflict do nothing;
