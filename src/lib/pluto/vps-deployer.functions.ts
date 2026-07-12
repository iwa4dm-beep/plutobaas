// Server functions: push migrations SQL + upload deployment bundle to VPS storage.
//
// Three steps (each returns its own status):
//   1. pushMigrations — POST /admin/v1/migrations  (raw SQL text)
//   2. uploadBundle   — POST /storage/v1/object/{bucket}/{path}  (base64 bytes)
//   3. verifyDeploy   — GET  /admin/v1/workspaces/:id/deployments  (latest)
//
// Bundle content is passed as base64 to keep the RPC payload plain-JSON.
// Individual step calls let the UI show per-step progress.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { vpsFetch, VpsError, getVpsBaseUrl, getServiceRoleKey } from "./vps-client";

// ---------- Step 1: push migrations ----------
const MigrationInput = z.object({
  workspaceId: z.string().min(1),
  sql: z.string().min(1).max(2 * 1024 * 1024), // 2 MB cap
  label: z.string().max(120).optional(),
});

export type PushMigrationResult =
  | { ok: true; migrationId: string; applied: number }
  | { ok: false; error: string; status: number };

export const pushMigrations = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => MigrationInput.parse(d))
  .handler(async ({ data }): Promise<PushMigrationResult> => {
    try {
      const r = await vpsFetch<{ id: string; applied?: number }>("/admin/v1/migrations", {
        method: "POST",
        body: {
          workspace_id: data.workspaceId,
          sql: data.sql,
          label: data.label ?? `auto-connect-${new Date().toISOString()}`,
        },
        timeoutMs: 60_000,
      });
      return { ok: true, migrationId: r.id, applied: r.applied ?? 0 };
    } catch (e) {
      const err = e instanceof VpsError ? e : new VpsError(String(e), 500, null);
      return { ok: false, error: err.message, status: err.status };
    }
  });

// ---------- Step 2: upload bundle to storage ----------
const UploadInput = z.object({
  workspaceId: z.string().min(1),
  bucket: z.string().min(1).max(64).default("deployments"),
  path: z.string().min(1).max(255),
  contentBase64: z.string().min(1).max(150 * 1024 * 1024 * 4 / 3), // ~150MB raw
  contentType: z.string().max(120).default("application/zip"),
});

export type UploadBundleResult =
  | { ok: true; key: string; size: number }
  | { ok: false; error: string; status: number };

export const uploadBundle = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => UploadInput.parse(d))
  .handler(async ({ data }): Promise<UploadBundleResult> => {
    const key = getServiceRoleKey();
    if (!key) return { ok: false, error: "PLUTO_SERVICE_ROLE_KEY not configured", status: 500 };

    // Decode base64 → Uint8Array
    const bin = atob(data.contentBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const base = getVpsBaseUrl();
    const cleanPath = data.path.replace(/^\/+/, "");
    const url = `${base}/storage/v1/object/${encodeURIComponent(data.bucket)}/${cleanPath}`;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 120_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          "content-type": data.contentType,
          "x-workspace-id": data.workspaceId,
          "x-upsert": "true",
        },
        body: bytes,
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: text || `HTTP ${res.status}`, status: res.status };
      return { ok: true, key: `${data.bucket}/${cleanPath}`, size: bytes.length };
    } catch (e) {
      return { ok: false, error: (e as Error).message, status: 0 };
    } finally {
      clearTimeout(t);
    }
  });

// ---------- Step 3: verify latest deployment ----------
const VerifyInput = z.object({ workspaceId: z.string().min(1) });

export type VerifyDeployResult =
  | { ok: true; latest: { id: string; createdAt?: string; status?: string } | null }
  | { ok: false; error: string; status: number };

export const verifyDeploy = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => VerifyInput.parse(d))
  .handler(async ({ data }): Promise<VerifyDeployResult> => {
    try {
      const r = await vpsFetch<{ items?: Array<{ id: string; created_at?: string; status?: string }> }>(
        `/admin/v1/workspaces/${encodeURIComponent(data.workspaceId)}/deployments?limit=1`,
        { method: "GET", timeoutMs: 15_000 },
      );
      const top = r.items?.[0];
      return {
        ok: true,
        latest: top ? { id: top.id, createdAt: top.created_at, status: top.status } : null,
      };
    } catch (e) {
      const err = e instanceof VpsError ? e : new VpsError(String(e), 500, null);
      return { ok: false, error: err.message, status: err.status };
    }
  });
