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
    const applied = await rawFetch(`${base}/admin/v1/migrations/${encodeURIComponent(id)}/apply`, "POST", headers, null, null, 60_000);
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
    const url = `${getVpsBaseUrl()}/admin/v1/workspaces/${encodeURIComponent(data.workspaceId)}/deployments?limit=1`;
    const r = await rawFetch(url, "GET", headers, null, null, 15_000);
    if (!r.ok) return { ok: false, error: r.text || `HTTP ${r.status}`, status: r.status, debug: r.debug };
    let parsed: { items?: Array<{ id: string; created_at?: string; status?: string }> } = {};
    try { parsed = JSON.parse(r.text); } catch { /* keep empty */ }
    const top = parsed.items?.[0];
    return {
      ok: true,
      latest: top ? { id: top.id, createdAt: top.created_at, status: top.status } : null,
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

    // 3. Verify admin API + workspace exists
    const verifyUrl = `${getVpsBaseUrl()}/admin/v1/workspaces/${encodeURIComponent(data.workspaceId)}/deployments?limit=1`;
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
