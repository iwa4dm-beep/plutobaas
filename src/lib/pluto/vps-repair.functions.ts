// One-click VPS repair — proxies whitelisted shell scripts on the VPS
// through the sandbox worker's authenticated /admin/repair endpoint.
//
// Server-side only: reads PLUTO_SANDBOX_URL + PLUTO_SANDBOX_SECRET from env
// and forwards to the worker with x-sandbox-secret. The worker sudo-runs
// /usr/local/sbin/pluto-repair (installed by bootstrap-sandbox-worker.sh),
// which dispatches to repair-sandbox-worker-and-site.sh, fix-wildcard-ssl.sh
// or deploy-and-verify.sh.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getVpsBaseUrl } from "./vps-client";

export type RepairAction = "worker-and-site" | "wildcard-ssl" | "per-slug-ssl" | "deploy-and-verify" | "all";

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
  action: z.enum(["worker-and-site", "wildcard-ssl", "per-slug-ssl", "deploy-and-verify", "all"]),
  slug: z.string().min(1).max(128).optional(),
  wildcard: z.string().min(3).max(253).optional(),
  acmeEmail: z.string().email().max(254).optional(),
});

export const runVpsRepair = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => Input.parse(d))
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
  .inputValidator((d: unknown) => PreflightInput.parse(d))
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
