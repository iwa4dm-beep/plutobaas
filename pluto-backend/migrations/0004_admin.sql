-- Pluto BaaS — admin / multi-tenant extensions

-- Project members (RBAC per project)
CREATE TABLE IF NOT EXISTS admin.project_members (
  project_id uuid NOT NULL REFERENCES admin.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_user_idx ON admin.project_members (user_id);

-- Superadmin flag on users (bootstrapped from env PLUTO_ROOT_EMAIL)
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS is_superadmin boolean NOT NULL DEFAULT false;

-- Ensure api_keys can be scoped/named uniquely per project
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_project_name_idx
  ON admin.api_keys (project_id, name)
  WHERE revoked_at IS NULL;

-- Helper: check membership
CREATE OR REPLACE FUNCTION admin.has_project_role(_project uuid, _user uuid, _roles text[])
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin.project_members
    WHERE project_id = _project AND user_id = _user AND role = ANY(_roles)
  ) OR EXISTS (
    SELECT 1 FROM auth.users WHERE id = _user AND is_superadmin = true
  );
$$;
