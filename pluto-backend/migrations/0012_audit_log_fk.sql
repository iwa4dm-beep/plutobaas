-- 0012_audit_log_fk.sql
-- Repairs installs where 0006_governance.sql was marked as applied before the
-- guarded FK block existed, leaving admin.audit_log without
-- audit_log_project_fk. Idempotent — safe to re-run.

do $$ begin
  -- Ensure column exists (older installs may still be missing it)
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'admin' and table_name = 'audit_log' and column_name = 'project_id'
  ) then
    alter table admin.audit_log add column project_id uuid;
  end if;

  -- Drop any stale FK on project_id that isn't named audit_log_project_fk
  -- (defensive; only fires if some other constraint name was used previously).
  perform 1
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
   where c.conrelid = 'admin.audit_log'::regclass
     and c.contype = 'f'
     and a.attname = 'project_id'
     and c.conname <> 'audit_log_project_fk';
  if found then
    execute (
      select 'alter table admin.audit_log drop constraint ' || quote_ident(c.conname)
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
       where c.conrelid = 'admin.audit_log'::regclass
         and c.contype = 'f'
         and a.attname = 'project_id'
         and c.conname <> 'audit_log_project_fk'
       limit 1
    );
  end if;

  -- Add the canonical FK if it's still missing.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'admin.audit_log'::regclass
       and conname = 'audit_log_project_fk'
  ) then
    alter table admin.audit_log
      add constraint audit_log_project_fk
      foreign key (project_id) references admin.projects(id) on delete cascade;
  end if;
end $$;
