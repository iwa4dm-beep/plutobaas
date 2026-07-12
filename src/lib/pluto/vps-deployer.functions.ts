// Server functions: push migrations SQL + upload deployment bundle to VPS storage.
//
// Each fn returns a `debug` field with the raw request URL/method/status/body
// (request body redacted-truncated) so the UI can render live per-step logs.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getVpsBaseUrl, getServiceRoleKey } from "./vps-client";

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

function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> | { error: string } {
  const key = getServiceRoleKey();
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
    const headers = serviceHeaders({ "content-type": "application/json" });
    if ("error" in headers) return { ok: false, error: headers.error, status: 500, debug: null };
    // Upstream shape (verified against api.timescard.cloud openapi + probe):
    //   POST /admin/v1/migrations  { name, up_sql, workspace_id }  -> 201 { id, ... }
    //   POST /admin/v1/migrations/{id}/apply                        -> 200 { ok, migration }
    const base = getVpsBaseUrl();
    const name = (data.label ?? `auto-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
    const body = JSON.stringify({ name, up_sql: data.sql, workspace_id: data.workspaceId });
    const created = await rawFetch(`${base}/admin/v1/migrations`, "POST", headers, body, body, 60_000);
    if (!created.ok) return { ok: false, error: created.text || `HTTP ${created.status}`, status: created.status, debug: created.debug };
    let parsed: { id?: string } = {};
    try { parsed = JSON.parse(created.text); } catch { /* keep empty */ }
    const id = parsed.id ?? "";
    if (!id) return { ok: false, error: "Upstream did not return migration id", status: 500, debug: created.debug };
    const applied = await rawFetch(`${base}/admin/v1/migrations/${encodeURIComponent(id)}/apply`, "POST", headers, "{}", "{}", 60_000);
    if (!applied.ok) return { ok: false, error: applied.text || `HTTP ${applied.status}`, status: applied.status, debug: applied.debug };
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
    const headers = serviceHeaders({
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
    const headers = serviceHeaders();
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
    const headers = serviceHeaders();
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
const EnsureInfraInput = z.object({ bucket: z.string().min(1).max(64).default("deployments") });

export type EnsureInfraStep = { key: string; label: string; ok: boolean; detail: string; debug: StepDebug | null };
export type EnsureInfraResult = { ok: boolean; steps: EnsureInfraStep[] };

export const ensureDeployInfra = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => EnsureInfraInput.parse(d))
  .handler(async ({ data }): Promise<EnsureInfraResult> => {
    const headers = serviceHeaders();
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
});

export type DeployStepKey = "ensure-infra" | "push-migrations" | "upload-bundle" | "verify-deploy";
export type DeployStepAttempt = { attempt: number; ok: boolean; detail: string; debug: StepDebug | null; startedAt: string; latencyMs: number };
export type DeployStepLog = { key: DeployStepKey; label: string; ok: boolean; attempts: DeployStepAttempt[]; result: string | null };
export type DeployAllResult = { ok: boolean; workspaceId: string; totalMs: number; steps: DeployStepLog[] };

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
    const headers = serviceHeaders({ "content-type": "application/json" });
    if ("error" in headers) {
      return { ok: false, workspaceId: data.workspaceId, totalMs: 0, steps: [{ key: "ensure-infra", label: "Auth", ok: false, attempts: [{ attempt: 1, ok: false, detail: headers.error, debug: null, startedAt: nowIso(), latencyMs: 0 }], result: null }] };
    }
    const base = getVpsBaseUrl();
    const steps: DeployStepLog[] = [];

    // Step 0: infra
    if (data.ensureInfra) {
      const infra = await withRetry("ensure-infra", "Ensure infra (service user + bucket)", data.maxRetries, async () => {
        const r = await ensureDeployInfra({ data: { bucket: data.bucket } });
        return { ok: r.ok, detail: r.steps.map(s => `${s.ok ? "✓" : "✗"} ${s.label}: ${s.detail}`).join(" | "), debug: null, result: r };
      });
      steps.push(infra);
      if (!infra.ok) return { ok: false, workspaceId: data.workspaceId, totalMs: Date.now() - t0, steps };
    }

    // Step 1: push migrations (create + apply)
    const migName = ((data.label ?? `deploy-${Date.now()}`)).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
    const migStep = await withRetry("push-migrations", "Push migrations (create + apply)", data.maxRetries, async () => {
      const body = JSON.stringify({ name: migName, up_sql: data.sql, workspace_id: data.workspaceId });
      const created = await rawFetch(`${base}/admin/v1/migrations`, "POST", headers, body, body, 60_000);
      if (!created.ok) return { ok: false, detail: `create HTTP ${created.status}: ${created.text.slice(0, 200)}`, debug: created.debug, result: null };
      let parsed: { id?: string } = {}; try { parsed = JSON.parse(created.text); } catch { /* ignore */ }
      const id = parsed.id ?? "";
      if (!id) return { ok: false, detail: "upstream returned no migration id", debug: created.debug, result: null };
      const applied = await rawFetch(`${base}/admin/v1/migrations/${encodeURIComponent(id)}/apply`, "POST", headers, "{}", "{}", 60_000);
      if (!applied.ok) return { ok: false, detail: `apply HTTP ${applied.status}: ${applied.text.slice(0, 200)}`, debug: applied.debug, result: { migrationId: id } };
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
      const uplHeaders = serviceHeaders({ "x-workspace-id": data.workspaceId, "x-upsert": "true" });
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

    return { ok: steps.every(s => s.ok), workspaceId: data.workspaceId, totalMs: Date.now() - t0, steps };
  });

