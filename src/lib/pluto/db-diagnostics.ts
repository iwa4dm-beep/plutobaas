// Shared helpers for the EXPLAIN analyzer and RLS policy debugger.
// All queries run through `pluto.db.runSql`, which the SDK gates behind
// admin/service_role — never expose these SQL builders to end-users.

export type PolicyRow = {
  schemaname: string;
  tablename: string;
  policyname: string;
  cmd: string;         // SELECT/INSERT/UPDATE/DELETE/ALL
  permissive: string;  // PERMISSIVE/RESTRICTIVE
  roles: string[];
  qual: string | null;      // USING (...)
  with_check: string | null; // WITH CHECK (...)
};

export type PlanNode = {
  nodeType: string;
  relation: string | null;
  alias: string | null;
  filter: string | null;
  indexName: string | null;
  cost: { startup: number; total: number };
  actualRows?: number;
  actualLoops?: number;
  actualTimeMs?: { startup: number; total: number };
  children: PlanNode[];
};

/** Wrap a user query with EXPLAIN in JSON format. Rejects DDL/multi-statement. */
export function buildExplain(sql: string, analyze: boolean): string {
  const clean = sql.trim().replace(/;+\s*$/, "");
  if (/;\s*(select|insert|update|delete|create|drop|alter|truncate)/i.test(clean)) {
    throw new Error("Only single-statement queries are allowed for EXPLAIN.");
  }
  if (!/^(select|insert|update|delete|with)\b/i.test(clean)) {
    throw new Error("EXPLAIN only supports SELECT/INSERT/UPDATE/DELETE/WITH statements.");
  }
  const opts = analyze ? "(ANALYZE true, VERBOSE true, BUFFERS true, FORMAT JSON)" : "(VERBOSE true, FORMAT JSON)";
  return `EXPLAIN ${opts} ${clean}`;
}

/** Extract fully-qualified table names referenced in the query (best-effort). */
export function extractTables(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:from|join|update|into)\s+(?:only\s+)?"?([a-z_][a-z0-9_]*)"?\.?"?([a-z_][a-z0-9_]*)?"?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const a = m[1]; const b = m[2];
    if (b) out.add(`${a.toLowerCase()}.${b.toLowerCase()}`);
    else out.add(`public.${a.toLowerCase()}`);
  }
  return [...out];
}

/** SQL to fetch pg_policies rows for the tables referenced by a query. */
export function buildPoliciesQuery(qualifiedTables: string[]): string {
  if (!qualifiedTables.length) return "select null::text where false";
  const pairs = qualifiedTables.map((t) => {
    const [s, n] = t.split(".");
    return `(schemaname = '${s.replace(/'/g, "''")}' and tablename = '${n.replace(/'/g, "''")}')`;
  }).join(" or ");
  return `select schemaname, tablename, policyname, cmd, permissive, roles, qual, with_check
          from pg_policies where ${pairs} order by schemaname, tablename, cmd, policyname`;
}

/** SQL to check whether RLS is enabled for the given tables. */
export function buildRlsStateQuery(qualifiedTables: string[]): string {
  if (!qualifiedTables.length) return "select null::text where false";
  const pairs = qualifiedTables.map((t) => {
    const [s, n] = t.split(".");
    return `(n.nspname = '${s.replace(/'/g, "''")}' and c.relname = '${n.replace(/'/g, "''")}')`;
  }).join(" or ");
  return `select n.nspname as schemaname, c.relname as tablename,
                 c.relrowsecurity as rls_enabled,
                 c.relforcerowsecurity as rls_forced
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where ${pairs}`;
}

/** Adapt pluto.db.runSql (columns/rows) shape into typed policy rows. */
export function adaptPolicyRows(res: { columns: string[]; rows: unknown[][] }): PolicyRow[] {
  const idx = (name: string) => res.columns.indexOf(name);
  const iSch = idx("schemaname"), iTbl = idx("tablename"), iPol = idx("policyname"),
        iCmd = idx("cmd"), iPerm = idx("permissive"), iRoles = idx("roles"),
        iQual = idx("qual"), iChk = idx("with_check");
  return res.rows.map((r) => {
    const rolesRaw = r[iRoles];
    let roles: string[] = [];
    if (Array.isArray(rolesRaw)) roles = rolesRaw.map(String);
    else if (typeof rolesRaw === "string") roles = rolesRaw.replace(/^{|}$/g, "").split(",").filter(Boolean);
    return {
      schemaname: String(r[iSch] ?? ""), tablename: String(r[iTbl] ?? ""),
      policyname: String(r[iPol] ?? ""), cmd: String(r[iCmd] ?? ""),
      permissive: String(r[iPerm] ?? ""), roles,
      qual: r[iQual] == null ? null : String(r[iQual]),
      with_check: r[iChk] == null ? null : String(r[iChk]),
    };
  });
}

/** Walk EXPLAIN JSON output into a flat tree of PlanNode. */
export function adaptExplainJson(raw: unknown): PlanNode | null {
  const top = Array.isArray(raw) ? raw[0] : raw;
  const plan = (top as { Plan?: unknown } | undefined)?.Plan;
  if (!plan) return null;
  const walk = (n: Record<string, unknown>): PlanNode => ({
    nodeType: String(n["Node Type"] ?? "unknown"),
    relation: (n["Relation Name"] as string) ?? null,
    alias: (n["Alias"] as string) ?? null,
    filter: (n["Filter"] as string) ?? (n["Index Cond"] as string) ?? null,
    indexName: (n["Index Name"] as string) ?? null,
    cost: {
      startup: Number(n["Startup Cost"] ?? 0),
      total: Number(n["Total Cost"] ?? 0),
    },
    actualRows: n["Actual Rows"] as number | undefined,
    actualLoops: n["Actual Loops"] as number | undefined,
    actualTimeMs: n["Actual Total Time"] != null ? {
      startup: Number(n["Actual Startup Time"] ?? 0),
      total: Number(n["Actual Total Time"] ?? 0),
    } : undefined,
    children: Array.isArray(n["Plans"])
      ? (n["Plans"] as Record<string, unknown>[]).map(walk)
      : [],
  });
  return walk(plan as Record<string, unknown>);
}

/** Detect nodes that look like an RLS filter (SubPlan on pg_policies-ish check). */
export function findRlsHints(node: PlanNode): string[] {
  const hints: string[] = [];
  const visit = (n: PlanNode) => {
    if (n.filter && /current_setting|auth\.uid|has_role|is_superadmin/i.test(n.filter)) {
      hints.push(`${n.nodeType} on ${n.relation ?? "?"}: ${n.filter}`);
    }
    n.children.forEach(visit);
  };
  visit(node);
  return hints;
}
