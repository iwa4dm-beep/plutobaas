// Per-slug secret rotation + repair history + subdomain provisioning.
// All calls proxy to the authenticated sandbox worker admin surface.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getVpsBaseUrl } from "./vps-client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WorkerJson = { [k: string]: any };

function envFirst(...keys: string[]): string {
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

function workerConfig() {
  const base = getVpsBaseUrl();
  const sandboxUrl = (envFirst("PLUTO_SANDBOX_URL") || `${base}/sandbox`).replace(/\/+$/, "");
  const secret = envFirst("PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET");
  return { sandboxUrl, secret };
}

async function workerFetch(pathAndQuery: string, init: RequestInit = {}): Promise<WorkerJson> {
  const { sandboxUrl, secret } = workerConfig();
  if (!secret) {
    return {
      ok: false,
      error: "PLUTO_SANDBOX_SECRET is not configured — set it in Lovable Cloud → Secrets.",
    };
  }
  const headers = new Headers(init.headers);
  headers.set("x-sandbox-secret", secret);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(`${sandboxUrl}${pathAndQuery}`, { ...init, headers });
  } catch (e) {
    return { ok: false, error: `Worker unreachable: ${(e as Error).message}` };
  }
  const text = await res.text();
  let parsed: WorkerJson = {};
  try { parsed = text ? (JSON.parse(text) as WorkerJson) : {}; } catch { parsed = { raw: text as unknown as string }; }
  return { ok: res.ok, status: res.status, ...parsed };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const SlugInput = z.object({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i, "invalid slug"),
  note: z.string().max(200).optional(),
});

export const rotateSlugSecret = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SlugInput.parse(d))
  .handler(async ({ data }): Promise<WorkerJson> =>
    workerFetch("/admin/secrets/rotate", {
      method: "POST",
      body: JSON.stringify({ slug: data.slug, note: data.note }),
    })
  );

export const revokeSlugSecret = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SlugInput.pick({ slug: true }).parse(d))
  .handler(async ({ data }): Promise<WorkerJson> =>
    workerFetch("/admin/secrets/revoke", {
      method: "POST",
      body: JSON.stringify({ slug: data.slug }),
    })
  );

export const getSlugSecretStatus = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SlugInput.pick({ slug: true }).parse(d))
  .handler(async ({ data }): Promise<WorkerJson> =>
    workerFetch(`/admin/secrets/status?slug=${encodeURIComponent(data.slug)}`)
  );

const HistoryInput = z.object({
  slug: z.string().max(128).optional(),
  action: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const getRepairHistory = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => HistoryInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<WorkerJson> => {
    const params = new URLSearchParams();
    if (data.slug) params.set("slug", data.slug);
    if (data.action) params.set("action", data.action);
    if (data.limit) params.set("limit", String(data.limit));
    return workerFetch(`/admin/repair/history${params.toString() ? `?${params.toString()}` : ""}`);
  });

const ProvisionInput = z.object({
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i, "invalid slug"),
  seed: z.boolean().optional(),
  rotateSecret: z.boolean().optional(),
  revealSecret: z.boolean().optional(),
  baseDomain: z.string().max(253).optional(),
});

export type ProvisionInputT = z.infer<typeof ProvisionInput>;

export const provisionSubdomain = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => ProvisionInput.parse(d))
  .handler(async ({ data }): Promise<WorkerJson> =>
    workerFetch("/admin/provision", { method: "POST", body: JSON.stringify(data) })
  );

// Shared helper used by /api/public/provision-subdomain.ts (raw HTTP route).
export async function callProvisionSubdomain(input: ProvisionInputT): Promise<WorkerJson> {
  const parsed = ProvisionInput.parse(input);
  return workerFetch("/admin/provision", { method: "POST", body: JSON.stringify(parsed) });
}
export const ProvisionSchema = ProvisionInput;
