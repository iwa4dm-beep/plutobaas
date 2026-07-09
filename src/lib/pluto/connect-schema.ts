/**
 * Consolidated baseline schema, RLS policies, and triggers used by:
 *   - AppendixSections (code block + download button)
 *   - MigrationRunner (statement-by-statement apply)
 *
 * Keep this as pure Postgres SQL — no shell, no template literals — so the
 * migration runner can split it on top-level semicolons safely.
 */
export const CONSOLIDATED_SCHEMA_SQL = `-- ============================================================
-- Pluto BaaS — baseline project schema
-- Idempotent: safe to re-run. Each statement is separated by
-- a top-level semicolon so the dashboard migration runner can
-- execute them one by one and report progress.
-- ============================================================

-- profiles: 1:1 with auth.users
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

alter table public.profiles enable row level security;

drop policy if exists "profiles owner read"   on public.profiles;
create policy "profiles owner read"   on public.profiles for select using (auth.uid() = id);

drop policy if exists "profiles owner write"  on public.profiles;
create policy "profiles owner write"  on public.profiles for update using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- roles: never store roles on profiles
do $$ begin
  create type public.app_role as enum ('admin', 'moderator', 'user');
exception when duplicate_object then null; end $$;

create table if not exists public.user_roles (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users(id) on delete cascade,
  role     public.app_role not null,
  unique (user_id, role)
);

grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

drop policy if exists "user_roles self read" on public.user_roles;
create policy "user_roles self read" on public.user_roles for select using (auth.uid() = user_id);

-- storage buckets + RLS
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('docs',    'docs',    false) on conflict (id) do nothing;

drop policy if exists "avatars public read" on storage.objects;
create policy "avatars public read" on storage.objects for select using (bucket_id = 'avatars');

drop policy if exists "avatars owner write" on storage.objects;
create policy "avatars owner write" on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "docs owner read" on storage.objects;
create policy "docs owner read" on storage.objects for select
  using (bucket_id = 'docs' and auth.uid()::text = (storage.foldername(name))[1]);

-- realtime broadcast on profiles
select public.pluto_enable_realtime('public.profiles');

-- example app table (todos) with RLS + realtime + updated_at trigger
create table if not exists public.todos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  done        boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

grant select, insert, update, delete on public.todos to authenticated;
grant all on public.todos to service_role;

alter table public.todos enable row level security;

drop policy if exists "todos owner all" on public.todos;
create policy "todos owner all" on public.todos for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_todos_touch on public.todos;
create trigger trg_todos_touch before update on public.todos
  for each row execute function public.touch_updated_at();

select public.pluto_enable_realtime('public.todos');
`;

/**
 * Split a SQL script into individually-executable statements while respecting
 * dollar-quoted bodies (used by our plpgsql functions) and single/double
 * quoted strings. Comments (-- ... EOL) are stripped for the split but the
 * original whitespace inside strings is preserved.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    const ch = sql[i];
    const next2 = sql.slice(i, i + 2);

    // line comment
    if (!inSingle && !inDouble && !dollarTag && next2 === "--") {
      const nl = sql.indexOf("\n", i);
      if (nl < 0) break;
      buf += " ";
      i = nl + 1;
      continue;
    }

    // dollar-quoted body open/close
    if (!inSingle && !inDouble) {
      const m = /^\$([A-Za-z0-9_]*)\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        if (dollarTag === null) dollarTag = tag;
        else if (dollarTag === tag) dollarTag = null;
        buf += tag;
        i += tag.length;
        continue;
      }
    }

    if (!dollarTag) {
      if (!inDouble && ch === "'") inSingle = !inSingle;
      else if (!inSingle && ch === '"') inDouble = !inDouble;
    }

    if (ch === ";" && !inSingle && !inDouble && !dollarTag) {
      const stmt = buf.trim();
      if (stmt.length) out.push(stmt);
      buf = "";
      i++;
      continue;
    }

    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail.length) out.push(tail);
  return out;
}

/** Best-effort short label from a SQL statement for progress UI. */
export function summariseStatement(stmt: string): string {
  const first = stmt.replace(/\s+/g, " ").trim().slice(0, 90);
  return first + (stmt.length > 90 ? "…" : "");
}
