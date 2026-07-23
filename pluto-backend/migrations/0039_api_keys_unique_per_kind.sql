-- 0039: allow same key name for anon + service_role in the same project.
-- Previous unique index (project_id, name) rejected minting service_role "timesnfc"
-- when an anon "timesnfc" already existed. Widen it to include the key's role
-- (exposed as "kind" in the API — the underlying column is admin.api_keys.role).

DROP INDEX IF EXISTS admin.api_keys_project_name_idx;

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_project_name_kind_idx
  ON admin.api_keys (project_id, name, role)
  WHERE revoked_at IS NULL;
