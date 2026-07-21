// One-click VPS repair — proxies whitelisted shell scripts on the VPS
// through the sandbox worker's authenticated /admin/repair endpoint.
//
// Server-side only: reads PLUTO_SANDBOX_URL + PLUTO_SANDBOX_SECRET from env
// and forwards to the worker with x-sandbox-secret. The worker sudo-runs
// /usr/local/sbin/pluto-repair (installed by bootstrap-sandbox-worker.sh),
// which dispatches to repair-sandbox-worker-and-site.sh, fix-wildcard-ssl.sh
// or deploy-and-verify.sh.
import { createServerFn } from "@tanstack/react-start";
import { requirePlutoAdmin } from "./admin-middleware";
import { z } from "zod";
import { getVpsBaseUrl } from "./vps-client";

export type RepairAction = "worker-and-site" | "wildcard-ssl" | "per-slug-ssl" | "primary-frontend" | "deploy-and-verify" | "set-upstream" | "all";

export type RepairResult = {
  ok: boolean;
  action: RepairAction;
  exitCode: number;
  durationMs: number;
  tail: string;         // last ~4 KB of combined stdout+stderr
  hint: string | null;  // human-readable next step on failure
  startedAt: string;
  finishedAt: string;
};

function envFirst(...keys: string[]): string {
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

const Input = z.object({
  action: z.enum(["worker-and-site", "wildcard-ssl", "per-slug-ssl", "primary-frontend", "deploy-and-verify", "set-upstream", "all"]),
  slug: z.string().min(1).max(128).optional(),
  wildcard: z.string().min(3).max(253).optional(),
  acmeEmail: z.string().email().max(254).optional(),
  // Only used by action="set-upstream" — rewrite PLUTO_UPSTREAM_URL in /etc/pluto/sandbox-worker.env.
  upstream: z
    .string()
    .url()
    .max(253)
    .refine((v) => !/<[^>]+>|your-project|example\.com|placeholder|supabase-ref/i.test(v), {
      message: "upstream cannot be a placeholder (contains <…>, supabase-ref, etc.)",
    })
    .optional(),
}).refine((d) => d.action !== "set-upstream" || !!d.upstream, {
  message: "action='set-upstream' requires an `upstream` URL",
  path: ["upstream"],
});

export const runVpsRepair = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin]).inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }): Promise<RepairResult> => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const base = getVpsBaseUrl();
    const sandboxUrl = (envFirst("PLUTO_SANDBOX_URL") || `${base}/sandbox`).replace(/\/+$/, "");
    const secret = envFirst("PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET");
    if (!secret) {
      return {
        ok: false, action: data.action, exitCode: -1, durationMs: 0,
        tail: "", startedAt, finishedAt: new Date().toISOString(),
        hint: "PLUTO_SANDBOX_SECRET is not configured in Lovable Cloud → Secrets. Run `sudo bash pluto-backend/deploy/print-sandbox-secret.sh` on the VPS and paste the printed value into Lovable Cloud → Secrets → PLUTO_SANDBOX_SECRET.",
      };
    }
    const endpoint = `${sandboxUrl}/admin/repair`;
    const body = JSON.stringify({
      action: data.action,
      slug: data.slug ?? "",
      wildcard: data.wildcard ?? "",
      acmeEmail: data.acmeEmail ?? "",
      upstream: data.upstream ?? "",
    });
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sandbox-secret": secret,
          accept: "application/json",
        },
        body,
      });
      const text = await r.text();
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - t0;
      if (!r.ok) {
        let hint: string | null = null;
        if (r.status === 401) hint = "Sandbox secret mismatch — PLUTO_SANDBOX_SECRET in Lovable Cloud does not match VPS SANDBOX_SHARED_SECRET. Run `sudo bash pluto-backend/deploy/print-sandbox-secret.sh` and paste the value into Lovable Cloud.";
        else if (r.status === 404) hint = "The VPS worker does not expose /admin/repair yet — pull latest and rerun `sudo bash pluto-backend/deploy/full-deploy.sh` to install the repair wrapper.";
        else if (r.status === 403) hint = "The worker refused to sudo /usr/local/sbin/pluto-repair. Rerun `sudo bash pluto-backend/deploy/full-deploy.sh` to reinstall the sudoers rule.";
        else if (r.status === 502 || r.status === 503) hint = "Sandbox worker is unreachable through nginx. Run repair-sandbox-worker.sh on the VPS.";
        return { ok: false, action: data.action, exitCode: r.status, durationMs, tail: text.slice(-4096), hint, startedAt, finishedAt };
      }
      let parsed: { ok?: boolean; exitCode?: number; tail?: string; hint?: string | null } = {};
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      return {
        ok: parsed.ok !== false && (parsed.exitCode == null || parsed.exitCode === 0),
        action: data.action,
        exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : 0,
        durationMs,
        tail: typeof parsed.tail === "string" ? parsed.tail.slice(-4096) : text.slice(-4096),
        hint: typeof parsed.hint === "string" ? parsed.hint : null,
        startedAt,
        finishedAt,
      };
    } catch (e) {
      return {
        ok: false, action: data.action, exitCode: -1, durationMs: Date.now() - t0,
        tail: "", startedAt, finishedAt: new Date().toISOString(),
        hint: `Network error contacting sandbox worker: ${(e as Error).message}`,
      };
    }
  });

// Preflight + auto-heal: run diagnostics for API/migrations, worker 404, wildcard SSL.
// Returns individual pass/fail; call runVpsRepair to remediate what failed.
export type PreflightHealResult = {
  api: { ok: boolean; status: number; detail: string };
  worker: { ok: boolean; status: number; detail: string };
  ssl: { ok: boolean; host: string; detail: string };
  slug404: { ok: boolean; url: string; status: number };
  suggestions: RepairAction[];
};

const PreflightInput = z.object({
  slug: z.string().min(1).max(128).optional(),
  wildcard: z.string().min(3).max(253).optional(),
});

export const preflightAndHeal = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin]).inputValidator((d: unknown) => PreflightInput.parse(d))
  .handler(async ({ data }): Promise<PreflightHealResult> => {
    const base = getVpsBaseUrl();
    const wildcard = (data.wildcard || envFirst("PLUTO_WILDCARD_HOST") || "").replace(/^\*\./, "").replace(/^https?:\/\//, "");
    const slug = data.slug || "";

    const suggestions = new Set<RepairAction>();
    async function probe(url: string, headers: Record<string, string> = {}) {
      try {
        const r = await fetch(url, { headers });
        const text = await r.text();
        return { status: r.status, ok: r.ok, detail: text.slice(0, 240) };
      } catch (e) { return { status: 0, ok: false, detail: (e as Error).message }; }
    }

    const api = await probe(`${base}/admin/v1/health`);
    if (!api.ok) suggestions.add("deploy-and-verify");

    const workerSecret = envFirst("PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET");
    const worker = await probe(`${base}/sandbox/health`, workerSecret ? { "x-sandbox-secret": workerSecret } : {});
    if (!worker.ok) suggestions.add("worker-and-site");

    // Slug served-site probe (uses base + /sites/<slug>/).
    let slug404 = { ok: true, url: "", status: 0 };
    if (slug) {
      const url = `${base}/sites/${encodeURIComponent(slug)}/`;
      const p = await probe(url);
      slug404 = { ok: p.ok, url, status: p.status };
      if (!p.ok && (p.status === 404 || p.status === 0)) suggestions.add("worker-and-site");
    }

    // Wildcard SSL check — attempt HTTPS handshake to a synthetic subdomain.
    let ssl = { ok: true, host: "", detail: "no wildcard host configured" };
    if (wildcard) {
      const testHost = `pluto-preflight-${Math.random().toString(36).slice(2, 8)}.${wildcard}`;
      const url = `https://${testHost}/`;
      try {
        const r = await fetch(url, { method: "HEAD", redirect: "manual" });
        ssl = { ok: true, host: testHost, detail: `HTTPS handshake ok (HTTP ${r.status})` };
      } catch (e) {
        const msg = (e as Error).message;
        const looksLikeCertError = /certificate|self.signed|hostname|SNI|SSL|ERR_TLS|ENOTFOUND/i.test(msg);
        ssl = { ok: false, host: testHost, detail: msg };
        if (looksLikeCertError) suggestions.add("wildcard-ssl");
      }
    }

    return { api, worker, ssl, slug404, suggestions: [...suggestions] };
  });

// ---- Per-slug cert status ---------------------------------------------------

export type SlugCertStatus = {
  ok: boolean;
  fqdn: string;
  exists: boolean;
  source: "per-slug" | "wildcard" | null;
  notBefore?: string | null;
  notAfter?: string | null;
  daysLeft?: number | null;
  issuer?: string;
  subject?: string;
  sans?: string[];
  coversFqdn?: boolean;
  hint?: string | null;
  error?: string;
};

const CertStatusInput = z.object({
  slug: z.string().min(1).max(64),
  wildcard: z.string().min(3).max(253).optional(),
});

export const getSlugCertStatus = createServerFn({ method: "GET" })
  .middleware([requirePlutoAdmin]).inputValidator((d: unknown) => CertStatusInput.parse(d))
  .handler(async ({ data }): Promise<SlugCertStatus> => {
    const base = getVpsBaseUrl();
    const sandboxUrl = (envFirst("PLUTO_SANDBOX_URL") || `${base}/sandbox`).replace(/\/+$/, "");
    const secret = envFirst("PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET");
    const wildcard = data.wildcard || envFirst("PLUTO_WILDCARD_HOST") || "app.timescard.app";
    const url = `${sandboxUrl}/admin/cert-status?slug=${encodeURIComponent(data.slug)}&wildcard=${encodeURIComponent(wildcard)}`;
    const fqdn = `${data.slug}.${wildcard}`;
    if (!secret) {
      return { ok: false, fqdn, exists: false, source: null, error: "PLUTO_SANDBOX_SECRET not configured" };
    }
    try {
      const r = await fetch(url, { headers: { "x-sandbox-secret": secret, accept: "application/json" } });
      const text = await r.text();
      if (!r.ok) return { ok: false, fqdn, exists: false, source: null, error: `HTTP ${r.status}: ${text.slice(0, 200)}` };
      return JSON.parse(text) as SlugCertStatus;
    } catch (e) {
      return { ok: false, fqdn, exists: false, source: null, error: (e as Error).message };
    }
  });

// ---- Batch per-slug HTTP-01 issuance ---------------------------------------

export type BatchIssueResult = {
  slug: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  tail: string;
  hint: string | null;
};

const BatchInput = z.object({
  slugs: z.array(z.string().min(1).max(64)).min(1).max(25),
  wildcard: z.string().min(3).max(253).optional(),
  acmeEmail: z.string().email().max(254).optional(),
});

export const batchIssuePerSlugCerts = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin]).inputValidator((d: unknown) => BatchInput.parse(d))
  .handler(async ({ data }): Promise<{ results: BatchIssueResult[] }> => {
    const base = getVpsBaseUrl();
    const sandboxUrl = (envFirst("PLUTO_SANDBOX_URL") || `${base}/sandbox`).replace(/\/+$/, "");
    const secret = envFirst("PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET");
    if (!secret) {
      return { results: data.slugs.map((slug) => ({ slug, ok: false, exitCode: -1, durationMs: 0, tail: "", hint: "PLUTO_SANDBOX_SECRET not configured in Lovable Cloud." })) };
    }
    const endpoint = `${sandboxUrl}/admin/repair`;
    // Sequential — each certbot run should not be parallelised (nginx reload, LE rate limits).
    const results: BatchIssueResult[] = [];
    for (const slug of data.slugs) {
      const t0 = Date.now();
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-sandbox-secret": secret, accept: "application/json" },
          body: JSON.stringify({ action: "per-slug-ssl", slug, wildcard: data.wildcard ?? "", acmeEmail: data.acmeEmail ?? "" }),
        });
        const text = await r.text();
        let parsed: { ok?: boolean; exitCode?: number; tail?: string; hint?: string | null } = {};
        try { parsed = JSON.parse(text); } catch { /* keep raw */ }
        results.push({
          slug,
          ok: parsed.ok !== false && (parsed.exitCode == null || parsed.exitCode === 0),
          exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : r.status,
          durationMs: Date.now() - t0,
          tail: (typeof parsed.tail === "string" ? parsed.tail : text).slice(-2048),
          hint: typeof parsed.hint === "string" ? parsed.hint : null,
        });
      } catch (e) {
        results.push({ slug, ok: false, exitCode: -1, durationMs: Date.now() - t0, tail: "", hint: (e as Error).message });
      }
    }
    return { results };
  });
