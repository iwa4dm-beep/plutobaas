// Pre-built RBAC / RLS templates.
//
// Each template generates ready-to-apply SQL: a role enum + `user_roles`
// table (roles NEVER live on the profile table), a SECURITY DEFINER
// `has_role()` helper to avoid recursive RLS, grants, and per-table policies
// derived from the chosen access matrix.

export type PolicyAction = "select" | "insert" | "update" | "delete";

export type TableRule = {
  table: string;
  /** Column holding the row owner (uuid -> auth.users.id). Empty = not owned. */
  ownerColumn: string;
  publicRead: boolean;
  ownerActions: PolicyAction[];
  adminActions: PolicyAction[];
  /** Extra role -> actions, e.g. moderator can update. */
  roleActions: Array<{ role: string; actions: PolicyAction[] }>;
};

export type RbacTemplate = {
  id: string;
  name: string;
  summary: string;
  roles: string[];
  tables: TableRule[];
};

const A = (...a: PolicyAction[]) => a;

export const RBAC_TEMPLATES: RbacTemplate[] = [
  {
    id: "blog",
    name: "Blog / CMS",
    summary: "Public reads for published posts, authors manage their own drafts, admins manage everything.",
    roles: ["admin", "editor", "author", "user"],
    tables: [
      {
        table: "posts",
        ownerColumn: "author_id",
        publicRead: true,
        ownerActions: A("select", "insert", "update", "delete"),
        adminActions: A("select", "insert", "update", "delete"),
        roleActions: [{ role: "editor", actions: A("select", "update") }],
      },
      {
        table: "comments",
        ownerColumn: "user_id",
        publicRead: true,
        ownerActions: A("select", "insert", "update", "delete"),
        adminActions: A("select", "delete"),
        roleActions: [{ role: "editor", actions: A("delete") }],
      },
    ],
  },
  {
    id: "saas",
    name: "SaaS app (per-user data)",
    summary: "Strictly private rows scoped to auth.uid(), plus an admin override role.",
    roles: ["admin", "user"],
    tables: [
      {
        table: "profiles",
        ownerColumn: "user_id",
        publicRead: false,
        ownerActions: A("select", "insert", "update"),
        adminActions: A("select", "update", "delete"),
        roleActions: [],
      },
      {
        table: "projects",
        ownerColumn: "owner_id",
        publicRead: false,
        ownerActions: A("select", "insert", "update", "delete"),
        adminActions: A("select", "insert", "update", "delete"),
        roleActions: [],
      },
    ],
  },
  {
    id: "multitenant",
    name: "Multi-tenant workspaces",
    summary: "Membership-based access: a row is visible when you belong to its workspace.",
    roles: ["owner", "admin", "member", "viewer"],
    tables: [
      {
        table: "workspace_items",
        ownerColumn: "created_by",
        publicRead: false,
        ownerActions: A("select", "insert", "update", "delete"),
        adminActions: A("select", "insert", "update", "delete"),
        roleActions: [
          { role: "member", actions: A("select", "insert", "update") },
          { role: "viewer", actions: A("select") },
        ],
      },
    ],
  },
  {
    id: "marketplace",
    name: "Marketplace",
    summary: "Public catalogue, seller-owned listings, buyer-private orders, admin moderation.",
    roles: ["admin", "seller", "buyer"],
    tables: [
      {
        table: "listings",
        ownerColumn: "seller_id",
        publicRead: true,
        ownerActions: A("select", "insert", "update", "delete"),
        adminActions: A("select", "update", "delete"),
        roleActions: [],
      },
      {
        table: "orders",
        ownerColumn: "buyer_id",
        publicRead: false,
        ownerActions: A("select", "insert"),
        adminActions: A("select", "update", "delete"),
        roleActions: [{ role: "seller", actions: A("select") }],
      },
    ],
  },
];

function policyName(table: string, suffix: string) {
  return `${table}_${suffix}`;
}

function actionSql(action: PolicyAction) {
  return action.toUpperCase();
}

function tablePolicies(t: TableRule): string {
  const out: string[] = [];
  const q = `public.${t.table}`;

  out.push(`-- ${t.table}`);
  out.push(`ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY;`);
  out.push(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${q} TO authenticated;`,
    `GRANT ALL ON ${q} TO service_role;`,
  );
  if (t.publicRead) out.push(`GRANT SELECT ON ${q} TO anon;`);

  if (t.publicRead) {
    out.push(
      `DROP POLICY IF EXISTS ${policyName(t.table, "public_read")} ON ${q};`,
      `CREATE POLICY ${policyName(t.table, "public_read")} ON ${q}`,
      `  FOR SELECT TO anon, authenticated USING (true);`,
    );
  }

  if (t.ownerColumn) {
    for (const a of t.ownerActions) {
      const name = policyName(t.table, `owner_${a}`);
      const cond = `auth.uid() = ${t.ownerColumn}`;
      out.push(`DROP POLICY IF EXISTS ${name} ON ${q};`);
      if (a === "insert") {
        out.push(`CREATE POLICY ${name} ON ${q}`, `  FOR INSERT TO authenticated WITH CHECK (${cond});`);
      } else if (a === "update") {
        out.push(`CREATE POLICY ${name} ON ${q}`, `  FOR UPDATE TO authenticated USING (${cond}) WITH CHECK (${cond});`);
      } else {
        out.push(`CREATE POLICY ${name} ON ${q}`, `  FOR ${actionSql(a)} TO authenticated USING (${cond});`);
      }
    }
  }

  const roleGroups = [
    ...(t.adminActions.length ? [{ role: "admin", actions: t.adminActions }] : []),
    ...t.roleActions.filter((r) => r.actions.length),
  ];
  for (const g of roleGroups) {
    for (const a of g.actions) {
      const name = policyName(t.table, `${g.role}_${a}`);
      const cond = `public.has_role(auth.uid(), '${g.role}')`;
      out.push(`DROP POLICY IF EXISTS ${name} ON ${q};`);
      if (a === "insert") {
        out.push(`CREATE POLICY ${name} ON ${q}`, `  FOR INSERT TO authenticated WITH CHECK (${cond});`);
      } else if (a === "update") {
        out.push(`CREATE POLICY ${name} ON ${q}`, `  FOR UPDATE TO authenticated USING (${cond}) WITH CHECK (${cond});`);
      } else {
        out.push(`CREATE POLICY ${name} ON ${q}`, `  FOR ${actionSql(a)} TO authenticated USING (${cond});`);
      }
    }
  }

  out.push("");
  return out.join("\n");
}

export function generateRbacSql(tpl: RbacTemplate): string {
  const roles = tpl.roles.map((r) => `'${r}'`).join(", ");
  return `-- Generated by Pluto BaaS — RBAC/RLS template: ${tpl.name}
-- ${tpl.summary}
--
-- Roles live in their OWN table (never on profiles) and are read through a
-- SECURITY DEFINER helper so RLS policies never recurse.

-- 1. Role enum
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM (${roles});
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. user_roles table
CREATE TABLE IF NOT EXISTS public.user_roles (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role    public.app_role NOT NULL,
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_roles_self_select ON public.user_roles;
CREATE POLICY user_roles_self_select ON public.user_roles
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- 3. Recursion-safe role check
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

DROP POLICY IF EXISTS user_roles_admin_all ON public.user_roles;
CREATE POLICY user_roles_admin_all ON public.user_roles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), '${tpl.roles[0]}'))
  WITH CHECK (public.has_role(auth.uid(), '${tpl.roles[0]}'));

-- 4. Table policies
${tpl.tables.map(tablePolicies).join("\n")}`;
}

/** Rollback for a generated template (drops policies, keeps data). */
export function generateRbacRollbackSql(tpl: RbacTemplate): string {
  const lines: string[] = [`-- Rollback for RBAC template: ${tpl.name}`];
  for (const t of tpl.tables) {
    const q = `public.${t.table}`;
    if (t.publicRead) lines.push(`DROP POLICY IF EXISTS ${policyName(t.table, "public_read")} ON ${q};`);
    for (const a of t.ownerActions) lines.push(`DROP POLICY IF EXISTS ${policyName(t.table, `owner_${a}`)} ON ${q};`);
    for (const a of t.adminActions) lines.push(`DROP POLICY IF EXISTS ${policyName(t.table, `admin_${a}`)} ON ${q};`);
    for (const g of t.roleActions) {
      for (const a of g.actions) lines.push(`DROP POLICY IF EXISTS ${policyName(t.table, `${g.role}_${a}`)} ON ${q};`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Example role assignments to seed after applying a template. */
export function generateRoleSeedSql(tpl: RbacTemplate, email: string): string {
  const safe = email.replace(/'/g, "''");
  return `-- Grant '${tpl.roles[0]}' to ${email}
INSERT INTO public.user_roles (user_id, role)
SELECT id, '${tpl.roles[0]}'::public.app_role FROM auth.users WHERE email = '${safe}'
ON CONFLICT (user_id, role) DO NOTHING;
`;
}
