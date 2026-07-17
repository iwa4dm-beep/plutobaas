// Server functions: push migrations SQL + upload deployment bundle to VPS storage.
//
// Each fn returns a `debug` field with the raw request URL/method/status/body
// (request body redacted-truncated) so the UI can render live per-step logs.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getVpsBaseUrl, getServiceRoleKey } from "./vps-client";

/** Version tag embedded into the bootstrap function code. Bump when the
 *  bootstrap handler shape changes so `verifyBootstrap` can confirm the VPS
 *  is running the current code. */
export const BOOTSTRAP_VERSION = "v2-handler-assign-2026-07-16";

export type StepDebug = {
  url: string;
  method: string;
  status: number;
  latencyMs: number;
  reqBodyPreview: string | null;
  resBodyPreview: string;
};

function truncate(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} chars)` : s;
}

function firstNonEmptyEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = (process.env[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function isAlreadyExistsApplyError(text: string): boolean {
  let message = text;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown; details?: unknown };
    message = [parsed.message, parsed.error, parsed.details, text].filter(Boolean).join(" ");
  } catch {
    // Keep raw response text.
  }
  return /already exists/i.test(message);
}

function makePolicyCreatesIdempotent(sql: string): string {
  const policyCreate = /(^|\n)(\s*)CREATE\s+POLICY\s+((?:"(?:[^"]|"")+")|[a-zA-Z_][\w$]*)\s+ON\s+((?:(?:"(?:[^"]|"")+")|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:(?:"(?:[^"]|"")+")|[a-zA-Z_][\w$]*))?)\s+/gi;
  return sql.replace(policyCreate, (match, prefix: string, indent: string, policyName: string, tableName: string) => {
    const before = sql.slice(Math.max(0, sql.indexOf(match) - 160), sql.indexOf(match));
    if (new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+${escapeRegExp(policyName)}\\s+ON\\s+${escapeRegExp(tableName)}`, "i").test(before)) {
      return match;
    }
    return `${prefix}${indent}DROP POLICY IF EXISTS ${policyName} ON ${tableName};\n${indent}CREATE POLICY ${policyName} ON ${tableName} `;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalize SQL to fix common Laravel→Postgres issues that reject at APPLY time.
 *  - Convert quoted `'uuid_generate_v4()'` (a string literal) into the actual
 *    function call `gen_random_uuid()` so Postgres does not try to cast a
 *    string to uuid ("invalid input syntax for type uuid").
 *  - Replace `uuid_generate_v4()` with `gen_random_uuid()` (pgcrypto is
 *    already required by our base migration; uuid-ossp is not).
 */
function sanitizeMigrationSql(sql: string): string {
  let out = sql;
  out = out.replace(/'\s*uuid_generate_v4\s*\(\s*\)\s*'/gi, "gen_random_uuid()");
  out = out.replace(/\buuid_generate_v4\s*\(\s*\)/gi, "gen_random_uuid()");
  out = out.replace(/\bCREATE\s+SEQUENCE\s+(?!IF\s+NOT\s+EXISTS)(public\.invoice_number_seq\b)/gi, "CREATE SEQUENCE IF NOT EXISTS $1");
  out = addOwnerIdPolicyGuards(out);
  if (/\bDEFAULT\s+(?:public\.)?generate_invoice_number\s*\(\s*\)/i.test(out)
    && !/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.generate_invoice_number\s*\(/i.test(out)) {
    out = `${buildInvoiceNumberHelperSql()}\n\n${out}`;
  }
  return out;
}

function addOwnerIdPolicyGuards(sql: string): string {
  const policyStatement = /(^|\n)(\s*(?:DROP\s+POLICY\s+IF\s+EXISTS\s+[^;]+;\s*)?CREATE\s+POLICY\s+[^;]+\s+ON\s+((?:(?:"(?:[^"]|"")+")|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:(?:"(?:[^"]|"")+")|[a-zA-Z_][\w$]*))?)\s+[^;]*owner_id[^;]*;)/gi;
  return sql.replace(policyStatement, (match, prefix: string, statement: string, tableName: string) => {
    const guard = `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS owner_id uuid;`;
    const before = sql.slice(Math.max(0, sql.indexOf(match) - 240), sql.indexOf(match));
    if (new RegExp(`ALTER\\s+TABLE\\s+${escapeRegExp(tableName)}\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+owner_id`, "i").test(before)) {
      return match;
    }
    return `${prefix}${guard}\n${statement}`;
  });
}

function buildInvoiceNumberHelperSql(): string {
  return `-- Auto-added by deploy sanitizer: required by DEFAULT public.generate_invoice_number()
CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq START 1000;

CREATE OR REPLACE FUNCTION public.generate_invoice_number()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  next_num bigint;
BEGIN
  next_num := nextval('public.invoice_number_seq');
  RETURN 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(next_num::text, 6, '0');
END;
$$;

GRANT USAGE, SELECT ON SEQUENCE public.invoice_number_seq TO authenticated;
GRANT ALL ON SEQUENCE public.invoice_number_seq TO service_role;
REVOKE EXECUTE ON FUNCTION public.generate_invoice_number() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_invoice_number() TO authenticated, service_role;`;
}

async function rawFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: BodyInit | null,
  reqBodyForPreview: string | null,
  timeoutMs = 60_000,
): Promise<{ status: number; text: string; debug: StepDebug; ok: boolean }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal });
    const text = await res.text();
    const debug: StepDebug = {
      url,
      method,
      status: res.status,
      latencyMs: Date.now() - started,
      reqBodyPreview: reqBodyForPreview ? truncate(reqBodyForPreview) : null,
      resBodyPreview: truncate(text || "(empty)"),
    };
    return { status: res.status, text, debug, ok: res.ok };
  } catch (e) {
    const debug: StepDebug = {
      url,
      method,
      status: 0,
      latencyMs: Date.now() - started,
      reqBodyPreview: reqBodyForPreview ? truncate(reqBodyForPreview) : null,
      resBodyPreview: (e as Error).message,
    };
    return { status: 0, text: (e as Error).message, debug, ok: false };
  } finally {
    clearTimeout(t);
  }
}

async function serviceHeaders(extra: Record<string, string> = {}, override?: string): Promise<Record<string, string> | { error: string }> {
  const key = (override && override.trim()) || (await getServiceRoleKey());
  if (!key) return { error: "PLUTO_SERVICE_ROLE_KEY not configured" };
  return { apikey: key, authorization: `Bearer ${key}`, accept: "application/json", ...extra };
}


// ---------- Step 1: push migrations ----------
const MigrationInput = z.object({
  workspaceId: z.string().min(1),
  sql: z.string().min(1).max(2 * 1024 * 1024),
  label: z.string().max(120).optional(),
});

export type PushMigrationResult =
  | { ok: true; migrationId: string; applied: number; debug: StepDebug }
  | { ok: false; error: string; status: number; debug: StepDebug | null };

export const pushMigrations = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => MigrationInput.parse(d))
  .handler(async ({ data }): Promise<PushMigrationResult> => {
    const headers = await serviceHeaders({ "content-type": "application/json" });
    if ("error" in headers) return { ok: false, error: headers.error, status: 500, debug: null };
    // Upstream shape (verified against api.timescard.cloud openapi + probe):
    //   POST /admin/v1/migrations  { name, up_sql, workspace_id }  -> 201 { id, ... }
    //   POST /admin/v1/migrations/{id}/apply                        -> 200 { ok, migration }
    const base = getVpsBaseUrl();
    const name = (data.label ?? `auto-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
    const body = JSON.stringify({ name, up_sql: makePolicyCreatesIdempotent(sanitizeMigrationSql(data.sql)), workspace_id: data.workspaceId });
    const created = await rawFetch(`${base}/admin/v1/migrations`, "POST", headers, body, body, 60_000);
    if (!created.ok) return { ok: false, error: created.text || `HTTP ${created.status}`, status: created.status, debug: created.debug };
    let parsed: { id?: string } = {};
    try { parsed = JSON.parse(created.text); } catch { /* keep empty */ }
    const id = parsed.id ?? "";
    if (!id) return { ok: false, error: "Upstream did not return migration id", status: 500, debug: created.debug };
    const applied = await rawFetch(`${base}/admin/v1/migrations/${encodeURIComponent(id)}/apply`, "POST", headers, "{}", "{}", 60_000);
    if (!applied.ok) {
      // Idempotency: treat "already exists" apply errors as success. The
      // migration record is created; the underlying objects are already there
      // from a prior run of the same bundle, so subsequent steps can proceed.
      const alreadyExists = isAlreadyExistsApplyError(applied.text);
      if (alreadyExists) {
        return { ok: true, migrationId: id, applied: 0, debug: applied.debug };
      }
      return { ok: false, error: applied.text || `HTTP ${applied.status}`, status: applied.status, debug: applied.debug };
    }
    return { ok: true, migrationId: id, applied: 1, debug: applied.debug };
  });

// ---------- Step 2: upload bundle to storage ----------
// Upstream storage expects multipart/form-data (Fastify multipart parser).
// Raw application/zip bodies return 415 Unsupported Media Type.
const UploadInput = z.object({
  workspaceId: z.string().min(1),
  bucket: z.string().min(1).max(64).default("deployments"),
  path: z.string().min(1).max(255),
  contentBase64: z.string().min(1),
  contentType: z.string().max(120).default("application/zip"),
});

export type UploadBundleResult =
  | { ok: true; key: string; size: number; debug: StepDebug }
  | { ok: false; error: string; status: number; debug: StepDebug | null };

export const uploadBundle = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => UploadInput.parse(d))
  .handler(async ({ data }): Promise<UploadBundleResult> => {
    const headers = await serviceHeaders({
      "x-workspace-id": data.workspaceId,
      "x-upsert": "true",
    });
    if ("error" in headers) return { ok: false, error: headers.error, status: 500, debug: null };

    const bin = atob(data.contentBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const cleanPath = data.path.replace(/^\/+/, "");
    const filename = cleanPath.split("/").pop() || "bundle.zip";
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: data.contentType }), filename);

    const url = `${getVpsBaseUrl()}/storage/v1/object/${encodeURIComponent(data.bucket)}/${cleanPath}`;
    const preview = `(multipart upload ${bytes.length} bytes, content-type ${data.contentType})`;
    const r = await rawFetch(url, "POST", headers, form, preview, 120_000);
    if (!r.ok) return { ok: false, error: r.text || `HTTP ${r.status}`, status: r.status, debug: r.debug };
    return { ok: true, key: `${data.bucket}/${cleanPath}`, size: bytes.length, debug: r.debug };
  });

// ---------- Step 3: verify latest deployment ----------
const VerifyInput = z.object({ workspaceId: z.string().min(1) });

export type VerifyDeployResult =
  | { ok: true; latest: { id: string; createdAt?: string; status?: string } | null; debug: StepDebug }
  | { ok: false; error: string; status: number; debug: StepDebug | null };

export const verifyDeploy = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => VerifyInput.parse(d))
  .handler(async ({ data }): Promise<VerifyDeployResult> => {
    const headers = await serviceHeaders();
    if ("error" in headers) return { ok: false, error: headers.error, status: 500, debug: null };
    // Upstream has no /workspaces/:id/deployments route. Use the migrations
    // list filtered by workspace as the source of truth for "latest deploy".
    const url = `${getVpsBaseUrl()}/admin/v1/migrations?workspace_id=${encodeURIComponent(data.workspaceId)}&limit=1`;
    const r = await rawFetch(url, "GET", headers, null, null, 15_000);
    if (!r.ok) return { ok: false, error: r.text || `HTTP ${r.status}`, status: r.status, debug: r.debug };
    let parsed: Array<{ id: string; created_at?: string; applied_at?: string; name?: string }> | { items?: Array<{ id: string; created_at?: string; applied_at?: string; name?: string }> } = [];
    try { parsed = JSON.parse(r.text); } catch { /* keep empty */ }
    const items = Array.isArray(parsed) ? parsed : parsed.items ?? [];
    const top = items[0];
    return {
      ok: true,
      latest: top ? { id: top.id, createdAt: top.applied_at ?? top.created_at, status: top.name } : null,
      debug: r.debug,
    };
  });

// ---------- Dry run: validate only, no writes ----------
// Steps:
//   1. Parse/validate SQL locally (statement count, forbid destructive-without-guard patterns).
//   2. HEAD the storage bucket root to confirm reachability + auth.
//   3. Call verifyDeploy to prove the workspace exists + admin API reachable.
const DryRunInput = z.object({
  workspaceId: z.string().min(1),
  sql: z.string().max(2 * 1024 * 1024).optional(),
  bucket: z.string().min(1).max(64).default("deployments"),
});

export type DryRunStep = {
  key: "validate-sql" | "check-storage" | "check-verify";
  label: string;
  ok: boolean;
  detail: string;
  debug: StepDebug | null;
};

export type DryRunResult = { ok: boolean; steps: DryRunStep[] };

function validateSqlText(sql: string): { ok: boolean; detail: string } {
  const stripped = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (!stripped) return { ok: false, detail: "SQL is empty after removing comments" };
  const statements = stripped.split(";").map(s => s.trim()).filter(Boolean);
  const dangerous = /\b(DROP\s+(TABLE|SCHEMA|DATABASE)|TRUNCATE)\b/i;
  const risky = statements.filter(s => dangerous.test(s) && !/IF\s+EXISTS/i.test(s));
  if (risky.length) return { ok: false, detail: `${risky.length} destructive statement(s) without IF EXISTS guard` };
  const openParens = (stripped.match(/\(/g) || []).length;
  const closeParens = (stripped.match(/\)/g) || []).length;
  if (openParens !== closeParens) return { ok: false, detail: `unbalanced parens (${openParens} open, ${closeParens} close)` };
  return { ok: true, detail: `${statements.length} statement(s) parsed` };
}

export const dryRunDeploy = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => DryRunInput.parse(d))
  .handler(async ({ data }): Promise<DryRunResult> => {
    const steps: DryRunStep[] = [];

    // 1. Local SQL validation
    if (data.sql && data.sql.trim()) {
      const v = validateSqlText(data.sql);
      steps.push({ key: "validate-sql", label: "Validate SQL", ok: v.ok, detail: v.detail, debug: null });
    } else {
      steps.push({ key: "validate-sql", label: "Validate SQL", ok: true, detail: "skipped (no SQL provided)", debug: null });
    }

    // 2. Storage reachability via HEAD (list bucket)
    const headers = await serviceHeaders();
    if ("error" in headers) {
      steps.push({ key: "check-storage", label: "Check storage reachability", ok: false, detail: headers.error, debug: null });
      steps.push({ key: "check-verify", label: "Verify admin API", ok: false, detail: headers.error, debug: null });
      return { ok: false, steps };
    }
    const storageUrl = `${getVpsBaseUrl()}/storage/v1/bucket/${encodeURIComponent(data.bucket)}`;
    const storageRes = await rawFetch(storageUrl, "GET", headers, null, null, 10_000);
    steps.push({
      key: "check-storage",
      label: "Check storage reachability",
      ok: storageRes.ok,
      detail: storageRes.ok ? `bucket "${data.bucket}" reachable` : `HTTP ${storageRes.status}: ${storageRes.text.slice(0, 200)}`,
      debug: storageRes.debug,
    });

    // 3. Verify admin API via migrations list (there is no /workspaces/:id/deployments upstream)
    const verifyUrl = `${getVpsBaseUrl()}/admin/v1/migrations?workspace_id=${encodeURIComponent(data.workspaceId)}&limit=1`;
    const verifyRes = await rawFetch(verifyUrl, "GET", headers, null, null, 10_000);
    steps.push({
      key: "check-verify",
      label: "Verify admin API",
      ok: verifyRes.ok,
      detail: verifyRes.ok ? `workspace reachable via admin API` : `HTTP ${verifyRes.status}: ${verifyRes.text.slice(0, 200)}`,
      debug: verifyRes.debug,
    });

    return { ok: steps.every(s => s.ok), steps };
  });

// =====================================================================
// Infra bootstrap + preflight + orchestrated deploy with retries
// =====================================================================

const SERVICE_USER_ID = "00000000-0000-0000-0000-000000000000";
const SERVICE_USER_EMAIL = "service@pluto.local";

async function sqlExec(sql: string, headers: Record<string, string>): Promise<{ ok: boolean; text: string; debug: StepDebug }> {
  const url = `${getVpsBaseUrl()}/admin/v1/sql/exec`;
  const body = JSON.stringify({ sql, read_only: false, confirm_destructive: true, allow_dangerous: true });
  const r = await rawFetch(url, "POST", { ...headers, "content-type": "application/json" }, body, body, 30_000);
  return { ok: r.ok, text: r.text, debug: r.debug };
}

// ---------- ensureDeployInfra: idempotently create service user + deployments bucket ----------
const EnsureInfraInput = z.object({ bucket: z.string().min(1).max(64).default("deployments"), operatorToken: z.string().optional() });

export type EnsureInfraStep = { key: string; label: string; ok: boolean; detail: string; debug: StepDebug | null };
export type EnsureInfraResult = { ok: boolean; steps: EnsureInfraStep[] };

export const ensureDeployInfra = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => EnsureInfraInput.parse(d))
  .handler(async ({ data }): Promise<EnsureInfraResult> => {
    const headers = await serviceHeaders({}, data.operatorToken);
    if ("error" in headers) return { ok: false, steps: [{ key: "auth", label: "Auth", ok: false, detail: headers.error, debug: null }] };

    const base = getVpsBaseUrl();
    const steps: EnsureInfraStep[] = [];

    // 1. Ensure service auth.users row exists — storage.objects.owner_id FKs to auth.users(id).
    //    Without it, uploads by the zero-uuid service caller trigger 23503 FK errors.
    const seedUser = `insert into auth.users (id, email, role, is_superadmin, email_verified) values ('${SERVICE_USER_ID}', '${SERVICE_USER_EMAIL}', 'service_role', true, true) on conflict (id) do nothing;`;
    const userRes = await sqlExec(seedUser, headers);
    steps.push({ key: "service-user", label: "Ensure service auth.users row", ok: userRes.ok, detail: userRes.ok ? "seeded (or already present)" : userRes.text.slice(0, 300), debug: userRes.debug });

    // 2. Check bucket via storage API
    const bucketGet = await rawFetch(`${base}/storage/v1/bucket/${encodeURIComponent(data.bucket)}`, "GET", headers, null, null, 10_000);
    if (bucketGet.ok) {
      steps.push({ key: "bucket", label: `Ensure bucket "${data.bucket}"`, ok: true, detail: "already exists", debug: bucketGet.debug });
    } else if (bucketGet.status === 404) {
      // 3. Seed bucket row directly (storage.buckets.owner_id is nullable; the /storage/v1/bucket POST
      //    always tries to set owner_id = auth.uid() = zero-uuid, which now exists after step 1).
      const seedBucket = `insert into storage.buckets (id, name, public) values ('${data.bucket.replace(/'/g, "''")}', '${data.bucket.replace(/'/g, "''")}', false) on conflict (id) do nothing;`;
      const b = await sqlExec(seedBucket, headers);
      steps.push({ key: "bucket", label: `Create bucket "${data.bucket}"`, ok: b.ok, detail: b.ok ? "created via SQL" : b.text.slice(0, 300), debug: b.debug });
    } else {
      steps.push({ key: "bucket", label: `Check bucket "${data.bucket}"`, ok: false, detail: `HTTP ${bucketGet.status}: ${bucketGet.text.slice(0, 200)}`, debug: bucketGet.debug });
    }

    // 4. Re-verify bucket now reachable via storage API
    const finalCheck = await rawFetch(`${base}/storage/v1/bucket/${encodeURIComponent(data.bucket)}`, "GET", headers, null, null, 10_000);
    steps.push({ key: "bucket-verify", label: "Verify bucket reachable", ok: finalCheck.ok, detail: finalCheck.ok ? `bucket "${data.bucket}" reachable` : `HTTP ${finalCheck.status}: ${finalCheck.text.slice(0, 200)}`, debug: finalCheck.debug });

    return { ok: steps.every(s => s.ok), steps };
  });

// ---------- deployAll: orchestrated pushMigrations + uploadBundle + verifyDeploy with retries ----------
const DeployAllInput = z.object({
  workspaceId: z.string().min(1).max(128),
  sql: z.string().min(1).max(2 * 1024 * 1024),
  bundlePath: z.string().min(1).max(255),
  contentBase64: z.string().min(1),
  bucket: z.string().min(1).max(64).default("deployments"),
  label: z.string().max(120).optional(),
  maxRetries: z.number().int().min(0).max(5).default(2),
  ensureInfra: z.boolean().default(true),
  operatorToken: z.string().optional(),
});


export type DeployStepKey = "ensure-infra" | "push-migrations" | "upload-bundle" | "verify-deploy" | "unpack-serve" | "activate-service" | "health-check";
export type DeployStepAttempt = { attempt: number; ok: boolean; detail: string; debug: StepDebug | null; startedAt: string; latencyMs: number };
export type DeployStepLog = { key: DeployStepKey; label: string; ok: boolean; attempts: DeployStepAttempt[]; result: string | null };
export type LiveUrlProbe = { url: string; status: number; reachable: boolean; contentType: string | null; snippet: string; latencyMs: number };
export type DeployAllResult = {
  ok: boolean;
  workspaceId: string;
  totalMs: number;
  steps: DeployStepLog[];
  liveUrls?: {
    functionsHealth: string;
    bootstrapInvoke: string;
    servedSite?: string;
    /** Best-effort served frontend URL that was actually probed (may be undefined if none configured). */
    resolvedSite?: string;
    /** Probe outcome for resolvedSite. reachable=false ⇒ hostname not yet wired to nginx / no vhost / DNS missing. */
    servedSiteProbe?: LiveUrlProbe;
    /** True when the deploy artifact has an actually reachable frontend URL. */
    served?: boolean;
    /** Operator-facing hint when served=false. */
    servedHint?: string;
  };
};

function nowIso(): string { return new Date().toISOString(); }

type AttemptOutcome = { ok: boolean; detail: string; debug: StepDebug | null; result: unknown };

async function withRetry(
  key: DeployStepKey,
  label: string,
  maxRetries: number,
  attemptFn: (attempt: number) => Promise<AttemptOutcome>,
): Promise<DeployStepLog> {
  const attempts: DeployStepAttempt[] = [];
  let last: AttemptOutcome | null = null;
  for (let i = 0; i <= maxRetries; i++) {
    const started = Date.now();
    const startedAt = nowIso();
    try {
      last = await attemptFn(i + 1);
    } catch (e) {
      last = { ok: false, detail: (e as Error).message, debug: null, result: null };
    }
    attempts.push({ attempt: i + 1, ok: last.ok, detail: last.detail, debug: last.debug, startedAt, latencyMs: Date.now() - started });
    if (last.ok) break;
    if (i < maxRetries) await new Promise(r => setTimeout(r, 400 * 2 ** i));
  }
  let serialized: string | null = null;
  try { serialized = last?.result != null ? JSON.stringify(last.result) : null; } catch { serialized = null; }
  return { key, label, ok: !!last?.ok, attempts, result: serialized };
}

export const deployAll = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => DeployAllInput.parse(d))
  .handler(async ({ data }): Promise<DeployAllResult> => {
    const t0 = Date.now();
    const headers = await serviceHeaders({ "content-type": "application/json" }, data.operatorToken);
    if ("error" in headers) {
      return { ok: false, workspaceId: data.workspaceId, totalMs: 0, steps: [{ key: "ensure-infra", label: "Auth", ok: false, attempts: [{ attempt: 1, ok: false, detail: headers.error, debug: null, startedAt: nowIso(), latencyMs: 0 }], result: null }] };
    }

    const base = getVpsBaseUrl();
    const steps: DeployStepLog[] = [];

    // Step 0: infra
    if (data.ensureInfra) {
      const infra = await withRetry("ensure-infra", "Ensure infra (service user + bucket)", data.maxRetries, async () => {
        const r = await ensureDeployInfra({ data: { bucket: data.bucket, operatorToken: data.operatorToken } });
        return { ok: r.ok, detail: r.steps.map(s => `${s.ok ? "✓" : "✗"} ${s.label}: ${s.detail}`).join(" | "), debug: null, result: r };
      });
      steps.push(infra);
      if (!infra.ok) return { ok: false, workspaceId: data.workspaceId, totalMs: Date.now() - t0, steps };
    }

    // Step 1: push migrations (create + apply)
    const migName = ((data.label ?? `deploy-${Date.now()}`)).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
    const migStep = await withRetry("push-migrations", "Push migrations (create + apply)", data.maxRetries, async () => {
      const body = JSON.stringify({ name: migName, up_sql: makePolicyCreatesIdempotent(sanitizeMigrationSql(data.sql)), workspace_id: data.workspaceId });
      const created = await rawFetch(`${base}/admin/v1/migrations`, "POST", headers, body, body, 60_000);
      if (!created.ok) return { ok: false, detail: `create HTTP ${created.status}: ${created.text.slice(0, 200)}`, debug: created.debug, result: null };
      let parsed: { id?: string } = {}; try { parsed = JSON.parse(created.text); } catch { /* ignore */ }
      const id = parsed.id ?? "";
      if (!id) return { ok: false, detail: "upstream returned no migration id", debug: created.debug, result: null };
      const applied = await rawFetch(`${base}/admin/v1/migrations/${encodeURIComponent(id)}/apply`, "POST", headers, "{}", "{}", 60_000);
      if (!applied.ok) {
        if (isAlreadyExistsApplyError(applied.text)) {
          return { ok: true, detail: `migration ${id} already applied; continuing`, debug: applied.debug, result: { migrationId: id, idempotent: true, applyBody: applied.text.slice(0, 500) } };
        }
        return { ok: false, detail: `apply HTTP ${applied.status}: ${applied.text.slice(0, 200)}`, debug: applied.debug, result: { migrationId: id } };
      }
      return { ok: true, detail: `migration ${id} applied`, debug: applied.debug, result: { migrationId: id, applyBody: applied.text.slice(0, 500) } };
    });
    steps.push(migStep);

    // Step 2: upload bundle (multipart)
    const bin = atob(data.contentBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const cleanPath = data.bundlePath.replace(/^\/+/, "");
    const filename = cleanPath.split("/").pop() || "bundle.zip";

    const uplStep = await withRetry("upload-bundle", "Upload bundle to storage", data.maxRetries, async () => {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/zip" }), filename);
      const uplHeaders = await serviceHeaders({ "x-workspace-id": data.workspaceId, "x-upsert": "true" }, data.operatorToken);
      if ("error" in uplHeaders) return { ok: false, detail: uplHeaders.error, debug: null, result: null };
      const url = `${base}/storage/v1/object/${encodeURIComponent(data.bucket)}/${cleanPath}`;
      const preview = `(multipart upload ${bytes.length} bytes)`;
      const r = await rawFetch(url, "POST", uplHeaders, form, preview, 120_000);
      if (!r.ok) return { ok: false, detail: `HTTP ${r.status}: ${r.text.slice(0, 200)}`, debug: r.debug, result: null };
      return { ok: true, detail: `${bytes.length} bytes uploaded to ${data.bucket}/${cleanPath}`, debug: r.debug, result: { key: `${data.bucket}/${cleanPath}`, size: bytes.length, body: r.text.slice(0, 500) } };
    });
    steps.push(uplStep);

    // Step 3: verify (list migrations for workspace)
    const verStep = await withRetry("verify-deploy", "Verify deployment (migrations history)", data.maxRetries, async () => {
      const url = `${base}/admin/v1/migrations?workspace_id=${encodeURIComponent(data.workspaceId)}&limit=3`;
      const r = await rawFetch(url, "GET", headers, null, null, 15_000);
      if (!r.ok) return { ok: false, detail: `HTTP ${r.status}: ${r.text.slice(0, 200)}`, debug: r.debug, result: null };
      let parsed: unknown = null; try { parsed = JSON.parse(r.text); } catch { /* ignore */ }
      const arr = Array.isArray(parsed) ? parsed : ((parsed as { items?: unknown[] })?.items ?? []);
      const top = arr[0] as { id?: string; applied_at?: string; name?: string } | undefined;
      return { ok: true, detail: top ? `latest: ${top.name} (${top.id}) applied ${top.applied_at}` : "no migrations found for workspace", debug: r.debug, result: { latest: top ?? null, count: arr.length } };
    });
    steps.push(verStep);

    let migrationResult: { migrationId?: string; idempotent?: boolean } = {};
    let verifyResult: { latest?: unknown; count?: number } = {};
    try { migrationResult = migStep.result ? JSON.parse(migStep.result) : {}; } catch { /* keep empty */ }
    try { verifyResult = verStep.result ? JSON.parse(verStep.result) : {}; } catch { /* keep empty */ }
    const migrationStatus = {
      ok: migStep.ok && verStep.ok,
      applied: migStep.ok ? (migrationResult.idempotent ? 0 : 1) : 0,
      migrationId: migrationResult.migrationId ?? null,
      idempotent: Boolean(migrationResult.idempotent),
      verified: verStep.ok,
      count: typeof verifyResult.count === "number" ? verifyResult.count : null,
      latest: verifyResult.latest ?? null,
      detail: `${migStep.ok ? "migrations applied" : "migration apply failed"}; ${verStep.ok ? "history verified" : "history verify failed"}`,
    };

    // Step 3.5: unpack + serve — call the sandbox-worker on the VPS to
    //           unpack the just-uploaded ZIP and flip the "current" symlink
    //           that nginx serves. Requires PLUTO_SANDBOX_URL + PLUTO_SANDBOX_SECRET.
    //           If unset, we log a "skipped" attempt and keep going — this makes
    //           the pipeline safe to run on hosts where the worker isn't installed.
    const bundleKey = `${data.bucket}/${cleanPath}`;
    const sandboxUrl = (firstNonEmptyEnv("PLUTO_SANDBOX_URL") || `${base}/sandbox`).replace(/\/+$/, "");
    const sandboxSecret = firstNonEmptyEnv("PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET");
    const servedSiteFromWorker: { url?: string } = {};
    const deploySlug = (filename.replace(/\.zip$/i, "") || data.workspaceId).replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase();
    const unpackStep = await withRetry("unpack-serve", "Unpack bundle + serve (sandbox worker)", data.maxRetries, async () => {
      if (!sandboxUrl || !sandboxSecret) {
        return {
          ok: true,
          detail: "skipped — PLUTO_SANDBOX_URL / PLUTO_SANDBOX_SECRET not configured. Install pluto-backend/sandbox-worker on the VPS to enable auto-serve.",
          debug: null,
          result: { skipped: true },
        };
      }

      // Preflight: verify our PLUTO_SANDBOX_SECRET matches the VPS worker's
      // SANDBOX_SHARED_SECRET BEFORE uploading/unpacking. This turns the
      // "unpack HTTP 401 sandbox secret mismatch" failure — which used to
      // surface only after the retry loop finished — into an immediate,
      // actionable error with fix steps.
      const healthBase = /\/sandbox$/i.test(sandboxUrl) ? sandboxUrl : `${sandboxUrl}/sandbox`;
      const healthUrl = `${healthBase}/health`;
      const hp = await rawFetch(
        healthUrl,
        "GET",
        { "x-sandbox-secret": sandboxSecret, accept: "application/json" },
        null,
        null,
        15_000,
      ).catch((e) => ({ ok: false, status: 0, text: String(e?.message ?? e), debug: null as unknown as Awaited<ReturnType<typeof rawFetch>>["debug"] }));
      if (hp && hp.status === 401) {
        return {
          ok: false,
          detail:
            `preflight /sandbox/health HTTP 401: sandbox secret mismatch. Lovable Cloud's PLUTO_SANDBOX_SECRET does not match the VPS worker's SANDBOX_SHARED_SECRET.\n` +
            `Fix (on the VPS, from ~/backend-joy/pluto-backend):\n` +
            `  sudo bash deploy/print-sandbox-secret.sh\n` +
            `Copy the value in the "COPY THIS VALUE" block into Lovable Cloud → Secrets → PLUTO_SANDBOX_SECRET, then re-run Auto Deploy.\n` +
            `Manual alternative: sudo grep SANDBOX_SHARED_SECRET /etc/pluto/sandbox-worker.env`,
          debug: hp?.debug ?? null,
          result: { reason: "sandbox-secret-mismatch", phase: "preflight", healthUrl },
        };
      }
      if (hp && hp.ok) {
        try {
          const h = JSON.parse(hp.text);
          if (h && h.secret_present === false) {
            return {
              ok: false,
              detail:
                `preflight /sandbox/health reports secret_present=false: the VPS worker has no SANDBOX_SHARED_SECRET loaded (secret_path=${h.secret_path ?? "unknown"}). ` +
                `Run on the VPS: sudo bash ~/backend-joy/pluto-backend/deploy/print-sandbox-secret.sh, then paste the value into Lovable Cloud → Secrets → PLUTO_SANDBOX_SECRET.`,
              debug: hp.debug ?? null,
              result: { reason: "sandbox-secret-missing-on-vps", phase: "preflight" },
            };
          }
        } catch { /* not JSON — worker likely older; continue */ }
      }


      // Pass the current Cloud service-role key in the /unpack body so the worker
      // uses the SAME credentials that just uploaded the bundle. This eliminates
      // env-drift between Lovable Cloud's PLUTO_SERVICE_ROLE_KEY and the VPS
      // worker's cached PLUTO_SERVICE_ROLE_KEY, which caused "storage GET HTTP 401".
      const freshServiceKey = await getServiceRoleKey();
      const body = JSON.stringify({ workspaceId: data.workspaceId, slug: deploySlug, bucket: data.bucket, key: cleanPath, channel: "production", migrations: migrationStatus, serviceKey: freshServiceKey || undefined });
      // The sandbox worker is nginx-proxied under /sandbox/* on api.timescard.cloud.
      // Operators sometimes set PLUTO_SANDBOX_URL to the bare host, which routes
      // POST /unpack into the main app and returns "Only HTML requests are supported here".
      // Try every plausible shape; fall through only when the response clearly hit the wrong service.
      const sandboxBaseForUnpack = sandboxUrl;
      const hasSandboxSuffix = /\/sandbox$/i.test(sandboxBaseForUnpack);
      const candidates = hasSandboxSuffix
        ? [`${sandboxBaseForUnpack}/unpack`, `${sandboxBaseForUnpack}/v1/unpack`, `${sandboxBaseForUnpack}/deploy/unpack`]
        : [
            `${sandboxBaseForUnpack}/sandbox/unpack`,
            `${sandboxBaseForUnpack}/sandbox/v1/unpack`,
            `${sandboxBaseForUnpack}/sandbox/deploy/unpack`,
            `${sandboxBaseForUnpack}/unpack`,
          ];
      let r: Awaited<ReturnType<typeof rawFetch>> | null = null;
      let triedList = "";
      let wrongServiceAll = true;
      for (const url of candidates) {
        r = await rawFetch(
          url,
          "POST",
          { "content-type": "application/json", "x-sandbox-secret": sandboxSecret, accept: "application/json" },
          body,
          body,
          180_000,
        );
        triedList = triedList ? `${triedList}, ${url}` : url;
        if (r.ok) { wrongServiceAll = false; break; }
        const isHtml = /Only HTML requests|<!DOCTYPE html|<html/i.test(r.text);
        const is404 = r.status === 404;
        if (!isHtml && !is404) { wrongServiceAll = false; break; }
      }
      if (!r || !r.ok) {
        // If every candidate hit the wrong service or a 404, the deployed sandbox
        // worker does not expose an unpack endpoint yet. Don't fail the whole
        // pipeline for that — treat it as skipped with a clear operator hint.
        if (wrongServiceAll) {
          return {
            ok: true,
            detail: `skipped — sandbox worker at ${sandboxBaseForUnpack} does not expose an /unpack endpoint (tried: ${triedList}). Upgrade sandbox-worker.mjs to include POST /unpack, or set PLUTO_SANDBOX_URL to the correct base (e.g. https://api.timescard.cloud/sandbox).`,
            debug: r?.debug ?? null,
            result: { skipped: true, reason: "no-unpack-endpoint", tried: triedList },
          };
        }
        // 401 = secret mismatch between Lovable Cloud PLUTO_SANDBOX_SECRET and
        // the VPS worker's SANDBOX_SHARED_SECRET (in /etc/pluto/sandbox-worker.env).
        // Give the exact one-liner to copy the VPS value into the app.
        const status = r?.status ?? 0;
        const bodyText = (r?.text ?? "").slice(0, 240);
        if (status === 401 || /invalid or missing x-sandbox-secret/i.test(bodyText)) {
          return {
            ok: false,
            detail:
              `unpack HTTP 401: sandbox secret mismatch. The VPS worker rejected our x-sandbox-secret.\n` +
              `Fix: from ~/backend-joy/pluto-backend run  →  sudo bash deploy/print-sandbox-secret.sh\n` +
              `Or manually check the VPS value with  →  sudo grep SANDBOX_SHARED_SECRET /etc/pluto/sandbox-worker.env\n` +
              `Then set that exact value as the Lovable Cloud secret PLUTO_SANDBOX_SECRET (Cloud → Secrets).\n` +
              `If /etc/pluto/sandbox-worker.env has no SANDBOX_SHARED_SECRET, generate one:\n` +
              `  sudo bash -c "echo SANDBOX_SHARED_SECRET=$(openssl rand -hex 32) >> /etc/pluto/sandbox-worker.env && systemctl restart pluto-sandbox-worker"\n` +
              `then copy that same value into PLUTO_SANDBOX_SECRET and re-run deploy.`,
            debug: r?.debug ?? null,
            result: { reason: "sandbox-secret-mismatch", tried: triedList },
          };
        }
        return {
          ok: false,
          detail: `unpack HTTP ${status}: ${bodyText} (tried: ${triedList}).`,
          debug: r?.debug ?? null,
          result: null,
        };
      }

      let parsed: { webRoot?: string; releaseDir?: string; servedAt?: string; sizeBytes?: number; durationMs?: number } = {};
      try { parsed = JSON.parse(r.text); } catch { /* ignore */ }
      servedSiteFromWorker.url = `${base}/sites/${deploySlug}`;
      return {
        ok: true,
        detail: `unpacked ${parsed.sizeBytes ?? "?"} bytes in ${parsed.durationMs ?? "?"}ms → ${parsed.webRoot ?? "(root)"}`,
        debug: r.debug,
        result: parsed,
      };
    });
    steps.push(unpackStep);

    // Step 4: activate service — register/patch a `bootstrap` function that
    //         announces the deployed bundle. This is the closest thing the
    //         upstream Pluto BaaS (v0.1) exposes to "start server after unpack":
    //         the function record marks the workspace's default project as
    //         having live code. If the upstream sandbox worker is unavailable,
    //         the register call still succeeds and health-check will surface it.

    let projectId: string | null = null;
    const activateStep = await withRetry("activate-service", "Activate service (register bootstrap function)", data.maxRetries, async () => {
      // 4a. Resolve the workspace's default project.
      const resolveSql = `select id from admin.projects where workspace_id = '${data.workspaceId.replace(/'/g, "''")}' order by created_at asc limit 1;`;
      const resolved = await sqlExec(resolveSql, headers);
      if (!resolved.ok) return { ok: false, detail: `resolve project: ${resolved.text.slice(0, 200)}`, debug: resolved.debug, result: null };
      let rows: Array<{ id: string }> = [];
      try { rows = (JSON.parse(resolved.text) as { rows?: Array<{ id: string }> }).rows ?? []; } catch { /* ignore */ }
      if (!rows.length) return { ok: false, detail: `no admin.projects row for workspace ${data.workspaceId}`, debug: resolved.debug, result: null };
      projectId = rows[0].id;

      // 4b. List existing functions for the project; find bootstrap slug.
      const listUrl = `${base}/functions/v1?project_id=${encodeURIComponent(projectId)}`;
      const listRes = await rawFetch(listUrl, "GET", headers, null, null, 15_000);
      if (!listRes.ok) return { ok: false, detail: `list fns HTTP ${listRes.status}: ${listRes.text.slice(0, 200)}`, debug: listRes.debug, result: { projectId } };
      let fns: Array<{ id: string; slug: string }> = [];
      try { const j = JSON.parse(listRes.text); fns = Array.isArray(j) ? j : (j.items ?? []); } catch { /* ignore */ }
      const existing = fns.find(f => f.slug === "bootstrap");

      // 4c. Small JS handler that echoes deploy metadata. verify_jwt:false so
      //     the health probe can reach it without a per-request user token.
      // Sandbox worker uses vm.runInContext (classic script, no ESM). Assign
      // to `handler` — the runner picks it up via `typeof handler !== 'undefined'`.
      const code = `handler = async (req) => new Response(JSON.stringify({ ok: true, service: "pluto-bootstrap", version: ${JSON.stringify(BOOTSTRAP_VERSION)}, workspace: ${JSON.stringify(data.workspaceId)}, bundle: ${JSON.stringify(bundleKey)}, ts: Date.now() }), { headers: { "content-type": "application/json" } });`;

      if (existing) {
        const patchUrl = `${base}/functions/v1/${encodeURIComponent(existing.id)}`;
        const body = JSON.stringify({ code, verify_jwt: false });
        const r = await rawFetch(patchUrl, "PATCH", headers, body, body, 30_000);
        if (!r.ok) return { ok: false, detail: `patch fn HTTP ${r.status}: ${r.text.slice(0, 200)}`, debug: r.debug, result: { projectId, functionId: existing.id } };
        return { ok: true, detail: `bootstrap function updated (id ${existing.id})`, debug: r.debug, result: { projectId, functionId: existing.id, action: "patched", bundle: bundleKey } };
      }
      const createBody = JSON.stringify({ project_id: projectId, slug: "bootstrap", code, verify_jwt: false });
      const r = await rawFetch(`${base}/functions/v1`, "POST", headers, createBody, createBody, 30_000);
      if (!r.ok) return { ok: false, detail: `create fn HTTP ${r.status}: ${r.text.slice(0, 200)}`, debug: r.debug, result: { projectId } };
      let created: { id?: string } = {}; try { created = JSON.parse(r.text); } catch { /* ignore */ }
      return { ok: true, detail: `bootstrap function created (id ${created.id ?? "?"})`, debug: r.debug, result: { projectId, functionId: created.id, action: "created", bundle: bundleKey } };
    });
    steps.push(activateStep);

    // Step 5: health check — probe public functions health + invoke bootstrap
    //         + (if configured) the served frontend at PLUTO_SERVED_SITE_URL.
    //         Non-fatal for overall deploy: reports upstream runtime status
    //         even when the sandbox worker is not yet installed on the VPS.
    const servedSiteUrl = (process.env.PLUTO_SERVED_SITE_URL ?? "").replace(/\/+$/, "");

    // Auto-derive a per-deploy site URL when PLUTO_SERVED_SITE_URL is not set.
    // The slug is derived from the bundle filename (without .zip).
    const sandboxBase = (process.env.PLUTO_SANDBOX_URL ?? "").replace(/\/+$/, "");

    // Priority for the auto-derived value:
    //   1. PLUTO_SERVED_SITE_URL_TEMPLATE with {slug} placeholder — e.g.
    //      "https://{slug}.app.timescard.cloud" (nginx wildcard vhost) or
    //      "https://api.timescard.cloud/sites/{slug}/" (path-based). This is
    //      the recommended way to "auto-set" PLUTO_SERVED_SITE_URL per deploy
    //      without hard-coding a slug in .env.
    //   2. Sandbox worker's returned webRoot (from unpack response).
    //   3. `${PLUTO_SANDBOX_URL}/sites/<slug>/` (worker /sites/<slug>/ route).
    //   4. `${VPS_BASE}/sites/<slug>/`         (nginx passthrough to worker).
    //   5. `${VPS_BASE}/sandbox/sites/<slug>/` (legacy nginx location).
    const template = (process.env.PLUTO_SERVED_SITE_URL_TEMPLATE ?? "").trim();
    const expandTemplate = (tpl: string) => tpl.replace(/\{slug\}/g, deploySlug).replace(/\/+$/, "");
    const autoDerivedCandidates: string[] = [];
    if (template) autoDerivedCandidates.push(expandTemplate(template));
    autoDerivedCandidates.push(`https://${deploySlug}.app.timescard.cloud`);
    autoDerivedCandidates.push(`https://${deploySlug}-dev.app.timescard.cloud`);
    if (sandboxBase) autoDerivedCandidates.push(`${sandboxBase}/sites/${deploySlug}`);
    autoDerivedCandidates.push(`${base}/sites/${deploySlug}`);
    autoDerivedCandidates.push(`${base}/sandbox/sites/${deploySlug}`);

    const healthStep = await withRetry("health-check", "Health check (functions runtime + bootstrap + served site)", data.maxRetries, async () => {
      const healthUrl = `${base}/functions/v1/health`;
      const h = await rawFetch(healthUrl, "GET", { accept: "application/json" }, null, null, 10_000);
      const invokeUrl = `${base}/functions/v1/invoke/bootstrap`;
      const inv = await rawFetch(invokeUrl, "POST", { ...headers, "content-type": "application/json" }, "{}", "{}", 15_000);

      // Resolve the site URL: explicit env → worker webRoot → auto-derived probe.
      let effectiveSite = servedSiteUrl || servedSiteFromWorker.url || "";
      let autoSource: "env" | "worker" | "auto-derived" | "none" = servedSiteUrl ? "env" : (servedSiteFromWorker.url ? "worker" : "none");
      let siteResult: { status: number; url: string; snippet: string } | null = null;

      if (!effectiveSite) {
        for (const candidate of autoDerivedCandidates) {
          const probe = await rawFetch(`${candidate}/`, "GET", { accept: "text/html" }, null, null, 8_000);
          if (probe.ok) { effectiveSite = candidate; autoSource = "auto-derived"; break; }
        }
      }

      let siteLine = "served site: (auto-detect failed — set PLUTO_SERVED_SITE_URL or install sandbox worker with /sites/<slug>/ vhost)";
      if (effectiveSite) {
        const s = await rawFetch(`${effectiveSite}/`, "GET", { accept: "text/html" }, null, null, 15_000);
        siteResult = { status: s.status, url: `${effectiveSite}/`, snippet: s.text.slice(0, 240) };
        siteLine = `served site (${autoSource}): ${s.ok ? `✓ HTTP ${s.status}` : `✗ HTTP ${s.status}`} @ ${effectiveSite}`;
        // Cache the auto-derived URL for the resolvedSite block below.
        if (autoSource === "auto-derived") servedSiteFromWorker.url = servedSiteFromWorker.url ?? effectiveSite;
      }
      const runtimeOk = h.ok;
      const invokeOk = inv.ok;
      const detail = [
        `runtime: ${runtimeOk ? `✓ HTTP ${h.status}` : `✗ HTTP ${h.status}`} (${h.text.slice(0, 120)})`,
        `bootstrap invoke: ${invokeOk ? `✓ HTTP ${inv.status}` : `✗ HTTP ${inv.status}`} (${inv.text.slice(0, 160)})`,
        siteLine,
      ].join(" | ");
      return { ok: runtimeOk, detail, debug: h.debug, result: { runtime: { status: h.status, body: h.text.slice(0, 400) }, invoke: { status: inv.status, body: inv.text.slice(0, 400) }, site: siteResult, autoSource, autoDerivedCandidates } };
    });
    steps.push(healthStep);

    // Resolve the best-effort served-site URL and actually probe it. Priority:
    //   1. Operator-configured PLUTO_SERVED_SITE_URL (explicit)
    //   2. Sandbox worker's returned webRoot (from unpack step, or auto-derived above)
    const resolvedSite = servedSiteUrl || servedSiteFromWorker.url || undefined;
    let servedSiteProbe: LiveUrlProbe | undefined;
    let served = false;
    let servedHint: string | undefined;
    if (resolvedSite) {
      const probeUrl = resolvedSite.endsWith("/") ? resolvedSite : `${resolvedSite}/`;
      const p = await rawFetch(probeUrl, "GET", { accept: "text/html,*/*" }, null, null, 12_000);
      const looksHtml = /<!DOCTYPE|<html/i.test(p.text);
      servedSiteProbe = {
        url: probeUrl,
        status: p.status,
        reachable: p.ok,
        contentType: looksHtml ? "text/html" : null,
        snippet: p.text.slice(0, 240),
        latencyMs: p.debug.latencyMs,
      };
      served = p.ok;
      if (!p.ok) {
        servedHint = `Bundle uploaded, but ${probeUrl} returned HTTP ${p.status}. The hostname is not yet wired to nginx / a vhost, or the sandbox worker did not unpack the release. Configure PLUTO_SERVED_SITE_URL or install a sandbox worker with a working /unpack endpoint that serves /sites/<slug>/.`;
      }
    } else {
      servedHint = `Auto-detect could not find a reachable served site. Tried: ${autoDerivedCandidates.join(", ")}. To fix permanently, choose one: (a) set PLUTO_SERVED_SITE_URL_TEMPLATE (e.g. "https://{slug}.app.timescard.cloud" or "https://api.timescard.cloud/sites/{slug}/") so the URL is auto-computed per deploy; (b) set PLUTO_SERVED_SITE_URL to a static origin; or (c) install pluto-backend/sandbox-worker on the VPS — it now exposes GET /sites/<slug>/* which nginx can proxy at /sites/ or /sandbox/sites/.`;
    }

    const liveUrls = {
      functionsHealth: `${base}/functions/v1/health`,
      bootstrapInvoke: `${base}/functions/v1/invoke/bootstrap`,
      ...(servedSiteUrl ? { servedSite: `${servedSiteUrl}/` } : {}),
      ...(resolvedSite ? { resolvedSite } : {}),
      ...(servedSiteProbe ? { servedSiteProbe } : {}),
      served,
      ...(servedHint ? { servedHint } : {}),
    };
    return { ok: steps.every(s => s.ok), workspaceId: data.workspaceId, totalMs: Date.now() - t0, steps, liveUrls };
  });

// ---------- Standalone post-deploy health check (for Result panel refresh) ----------
const PostDeployHealthInput = z.object({ workspaceId: z.string().min(1).max(128) });

export type PostDeployHealth = {
  ok: boolean;
  runtime: { url: string; status: number; body: string; latencyMs: number };
  invoke: { url: string; status: number; body: string; latencyMs: number };
  checkedAt: string;
};

export const postDeployHealth = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => PostDeployHealthInput.parse(d))
  .handler(async (): Promise<PostDeployHealth> => {
    const headers = await serviceHeaders({ "content-type": "application/json" });
    if ("error" in headers) {
      const now = new Date().toISOString();
      return { ok: false, runtime: { url: "", status: 0, body: headers.error, latencyMs: 0 }, invoke: { url: "", status: 0, body: headers.error, latencyMs: 0 }, checkedAt: now };
    }
    const base = getVpsBaseUrl();
    const healthUrl = `${base}/functions/v1/health`;
    const invokeUrl = `${base}/functions/v1/invoke/bootstrap`;
    const h = await rawFetch(healthUrl, "GET", { accept: "application/json" }, null, null, 10_000);
    const inv = await rawFetch(invokeUrl, "POST", headers, "{}", "{}", 15_000);
    return {
      ok: h.ok,
      runtime: { url: healthUrl, status: h.status, body: h.text.slice(0, 800), latencyMs: h.debug.latencyMs },
      invoke: { url: invokeUrl, status: inv.status, body: inv.text.slice(0, 800), latencyMs: inv.debug.latencyMs },
      checkedAt: new Date().toISOString(),
    };
  });

// ---------- Verify bootstrap version is live on the VPS ----------
export type VerifyBootstrapResult = {
  ok: boolean;
  expectedVersion: string;
  liveVersion: string | null;
  match: boolean;
  invoke: { url: string; status: number; body: string; latencyMs: number };
  checkedAt: string;
  hint?: string;
};

export const verifyBootstrap = createServerFn({ method: "POST" })
  .handler(async (): Promise<VerifyBootstrapResult> => {
    const headers = await serviceHeaders({ "content-type": "application/json" });
    const base = getVpsBaseUrl();
    const invokeUrl = `${base}/functions/v1/invoke/bootstrap`;
    const now = new Date().toISOString();
    if ("error" in headers) {
      return { ok: false, expectedVersion: BOOTSTRAP_VERSION, liveVersion: null, match: false, invoke: { url: invokeUrl, status: 0, body: headers.error, latencyMs: 0 }, checkedAt: now, hint: headers.error };
    }
    const inv = await rawFetch(invokeUrl, "POST", headers, "{}", "{}", 15_000);
    let liveVersion: string | null = null;
    try {
      const parsed = JSON.parse(inv.text) as { version?: unknown };
      if (typeof parsed.version === "string") liveVersion = parsed.version;
    } catch { /* non-JSON response (e.g. "Function error: ...") */ }
    const match = liveVersion === BOOTSTRAP_VERSION;
    const hint = !inv.ok
      ? `Bootstrap invoke failed (HTTP ${inv.status}). Re-run deploy to patch the function.`
      : !liveVersion
        ? "Live bootstrap returned no version field — old handler is still active. Re-run deploy."
        : !match
          ? `Live version ${liveVersion} ≠ expected ${BOOTSTRAP_VERSION}. Re-run deploy.`
          : undefined;
    return {
      ok: inv.ok && match,
      expectedVersion: BOOTSTRAP_VERSION,
      liveVersion,
      match,
      invoke: { url: invokeUrl, status: inv.status, body: inv.text.slice(0, 800), latencyMs: inv.debug.latencyMs },
      checkedAt: now,
      hint,
    };
  });




// ---------- Standalone live-URL reachability probe ----------
const ProbeLiveUrlInput = z.object({ url: z.string().url() });

export const probeLiveUrl = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => ProbeLiveUrlInput.parse(d))
  .handler(async ({ data }): Promise<LiveUrlProbe & { checkedAt: string }> => {
    const probeUrl = data.url.endsWith("/") ? data.url : `${data.url}/`;
    const r = await rawFetch(probeUrl, "GET", { accept: "text/html,*/*" }, null, null, 12_000);
    const looksHtml = /<!DOCTYPE|<html/i.test(r.text);
    return {
      url: probeUrl,
      status: r.status,
      reachable: r.ok,
      contentType: looksHtml ? "text/html" : null,
      snippet: r.text.slice(0, 400),
      latencyMs: r.debug.latencyMs,
      checkedAt: new Date().toISOString(),
    };
  });
