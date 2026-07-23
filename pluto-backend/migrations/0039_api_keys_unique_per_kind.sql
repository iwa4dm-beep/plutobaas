-- 0039: allow same key name for anon + service_role in the same project.
-- Previous unique index (project_id, name) rejected minting service_role "timesnfc"
-- when an anon "timesnfc" already existed. Widen it to include kind.

DROP INDEX IF EXISTS admin.api_keys_project_name_idx;

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_project_name_kind_idx
  ON admin.api_keys (project_id, name, kind)
  WHERE revoked_at IS NULL;
