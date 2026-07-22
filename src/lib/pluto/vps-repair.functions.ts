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

export type RepairAction = "worker-and-site" | "wildcard-ssl" | "per-slug-ssl" | "primary-frontend" | "deploy-and-verify" | "set-upstream" | "sync-scripts" | "all";

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
  action: z.enum(["worker-and-site", "wildcard-ssl", "per-slug-ssl", "primary-frontend", "deploy-and-verify", "set-upstream", "sync-scripts", "all"]),
  slug: z.string().max(128).optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  wildcard: z.string().max(253).optional().transform((v) => (v && v.trim().length >= 3 ? v.trim() : undefined)),
  acmeEmail: z.string().max(254).optional().transform((v) => (v && v.trim() ? v.trim() : undefined)).pipe(z.string().email().max(254).optional()),
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
      const failedBecauseScriptsMoved = typeof parsed.exitCode === "number" && parsed.exitCode === 127 && /No such file or directory|no deploy dir found|deploy scripts moved|backend-joy/i.test(`${parsed.tail ?? ""} ${parsed.hint ?? ""}`);
      if (failedBecauseScriptsMoved && data.action !== "sync-scripts") {
        const syncBody = JSON.stringify({ action: "sync-scripts" });
        const sync = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sandbox-secret": secret,
            accept: "application/json",
          },
          body: syncBody,
        });
        const syncText = await sync.text();
        let syncParsed: { ok?: boolean; exitCode?: number; tail?: string; hint?: string | null } = {};
        try { syncParsed = JSON.parse(syncText); } catch { /* keep raw */ }
        if (sync.ok && syncParsed.ok !== false && (syncParsed.exitCode == null || syncParsed.exitCode === 0)) {
          const retry = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-sandbox-secret": secret,
              accept: "application/json",
            },
            body,
          });
          const retryText = await retry.text();
          try { parsed = JSON.parse(retryText); } catch { parsed = { ok: retry.ok, exitCode: retry.ok ? 0 : retry.status, tail: retryText }; }
          const retryOk = retry.ok && parsed.ok !== false && (parsed.exitCode == null || parsed.exitCode === 0);
          return {
            ok: retryOk,
            action: data.action,
            exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : (retryOk ? 0 : retry.status),
            durationMs: Date.now() - t0,
            tail: `Auto-synced deploy scripts via /opt/pluto/deploy, then retried.\n\n${typeof parsed.tail === "string" ? parsed.tail : retryText}`.slice(-4096),
            hint: retryOk ? null : (typeof parsed.hint === "string" ? parsed.hint : "Repair retry failed after syncing deploy scripts — inspect tail."),
            startedAt,
            finishedAt: new Date().toISOString(),
          };
        }
        return {
          ok: false,
          action: data.action,
          exitCode: 127,
          durationMs: Date.now() - t0,
          tail: `Original repair failed because deploy scripts were missing. sync-scripts also failed.\n\nOriginal:\n${parsed.tail ?? text}\n\nSync:\n${syncParsed.tail ?? syncText}`.slice(-4096),
          hint: "The VPS wrapper is stale or cannot find deploy scripts. Run the path-independent bootstrap from the real checkout, then retry: sudo find /root /opt /srv /home -maxdepth 8 -type f -path '*/pluto-backend/deploy/bootstrap-sandbox-worker.sh' -print -quit | xargs -r sudo bash",
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      }
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
  slug: z.string().max(128).optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  wildcard: z.string().max(253).optional().transform((v) => (v && v.length >= 3 ? v : undefined)),
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
        const primaryHeader = r.headers.get("x-pluto-primary") || "";
        const releaseHeader = r.headers.get("x-pluto-release") || "";
        return { status: r.status, ok: r.ok, detail: `x-pluto-primary=${primaryHeader}; x-pluto-release=${releaseHeader}; ${text.slice(0, 240)}`, primaryHeader };
      } catch (e) { return { status: 0, ok: false, detail: (e as Error).message, primaryHeader: "" }; }
    }

    const api = await probe(`${base}/admin/v1/health`);
    if (!api.ok) suggestions.add("deploy-and-verify");

    const workerSecret = envFirst("PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET");
    const worker = await probe(`${base}/sandbox/health`, workerSecret ? { "x-sandbox-secret": workerSecret } : {});
    if (!worker.ok) suggestions.add("worker-and-site");

    // Primary served-site probe: this stack publishes every latest project to
    // app.timescard.cloud, not the legacy /sites/<slug>/ route.
    let slug404 = { ok: true, url: "", status: 0 };
    if (slug) {
      const url = envFirst("PLUTO_PRIMARY_FRONTEND_URL") || "https://app.timescard.cloud";
      const p = await probe(url);
      const routedToPrimary = p.ok && p.primaryHeader.length > 0;
      slug404 = { ok: routedToPrimary, url, status: p.status };
      if (!p.ok && (p.status === 404 || p.status === 0)) suggestions.add("worker-and-site");
      if (p.ok && !routedToPrimary) suggestions.add("primary-frontend");
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
    const wildcard = data.wildcard || envFirst("PLUTO_WILDCARD_HOST") || "app.timescard.cloud";
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

// ---- Repair channel diagnostic ---------------------------------------------
// Verifies each One-click Fix feature is actually wired to the VPS:
//   1. Sandbox URL + secret env presence
//   2. Worker /healthz reachability + version/features
//   3. /admin/repair auth (bogus secret → 401 confirms endpoint is live)
//   4. /admin/repair with real secret + `_probe` action → wrapper install check
//   5. Per action, calls the wrapper in `dryRun` mode when supported, else
//      reports "wired" if the endpoint accepts the action shape (2xx / 4xx
//      other than 404 = wired).

export type RepairChannelActionProbe = {
  action: RepairAction;
  wired: boolean;
  status: number;
  detail: string;
};

export type RepairChannelDiagnostic = {
  sandboxUrl: string;
  secretConfigured: boolean;
  worker: { ok: boolean; status: number; version?: string; features?: string; detail: string };
  endpointAuth: { ok: boolean; status: number; detail: string };
  wrapperInstalled: { ok: boolean; status: number; detail: string };
  actions: RepairChannelActionProbe[];
  hint: string | null;
};

export const diagnoseRepairChannel = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator(() => ({}))
  .handler(async (): Promise<RepairChannelDiagnostic> => {
    const base = getVpsBaseUrl();
    const sandboxUrl = (envFirst("PLUTO_SANDBOX_URL") || `${base}/sandbox`).replace(/\/+$/, "");
    const secret = envFirst("PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET");
    const out: RepairChannelDiagnostic = {
      sandboxUrl,
      secretConfigured: !!secret,
      worker: { ok: false, status: 0, detail: "not probed" },
      endpointAuth: { ok: false, status: 0, detail: "not probed" },
      wrapperInstalled: { ok: false, status: 0, detail: "not probed" },
      actions: [],
      hint: null,
    };

    // 1. Worker /healthz
    try {
      const r = await fetch(`${sandboxUrl}/healthz`);
      const text = await r.text();
      out.worker.status = r.status;
      out.worker.ok = r.ok;
      out.worker.detail = text.slice(0, 200);
      try {
        const j = JSON.parse(text);
        out.worker.version = j.version;
        out.worker.features = j.features ? JSON.stringify(j.features) : undefined;
      } catch { /* keep raw */ }
    } catch (e) { out.worker.detail = (e as Error).message; }

    // 2. /admin/repair auth check (bogus secret should give 401)
    try {
      const r = await fetch(`${sandboxUrl}/admin/repair`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sandbox-secret": "definitely-bogus-diagnose" },
        body: JSON.stringify({ action: "worker-and-site" }),
      });
      const text = await r.text();
      out.endpointAuth.status = r.status;
      out.endpointAuth.ok = r.status === 401;
      out.endpointAuth.detail = r.status === 401
        ? "401 as expected — endpoint present, secret enforced"
        : r.status === 404
          ? "404 — /admin/repair not installed; run full-deploy.sh"
          : `unexpected HTTP ${r.status}: ${text.slice(0, 160)}`;
    } catch (e) { out.endpointAuth.detail = (e as Error).message; }

    if (!secret) {
      out.hint = "PLUTO_SANDBOX_SECRET is missing in Lovable Cloud → Secrets. Repair buttons will fail with 401. Run `sudo bash pluto-backend/deploy/print-sandbox-secret.sh` on the VPS and paste the value.";
      return out;
    }

    // 3. Wrapper install check — with real secret + unknown probe action
    try {
      const r = await fetch(`${sandboxUrl}/admin/repair`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sandbox-secret": secret },
        body: JSON.stringify({ action: "__diagnose_probe__" }),
      });
      const text = await r.text();
      out.wrapperInstalled.status = r.status;
      // Anything that reaches the wrapper and reports an unknown-action / bad-arg
      // error means the wrapper is installed. 200 with tail also means installed.
      const looksLikeWrapper = /unknown action|invalid action|unsupported|usage:|pluto-repair/i.test(text);
      out.wrapperInstalled.ok = r.status === 200 || (r.status >= 400 && r.status < 500 && looksLikeWrapper) || r.status === 400 || r.status === 422;
      out.wrapperInstalled.detail = out.wrapperInstalled.ok
        ? "wrapper reachable (rejected probe action)"
        : r.status === 403
          ? "403 — worker cannot sudo /usr/local/sbin/pluto-repair (sudoers rule missing). Rerun full-deploy.sh."
          : r.status === 404
            ? "404 — wrapper not installed. Rerun full-deploy.sh."
            : `HTTP ${r.status}: ${text.slice(0, 160)}`;
    } catch (e) { out.wrapperInstalled.detail = (e as Error).message; }

    // 4. Per-action wiring probe — send each action with an obviously invalid
    // slug/wildcard so the wrapper rejects fast without side effects. Success
    // criteria: response reached the wrapper (status ≠ 404 and ≠ 502/503).
    const probeActions: RepairAction[] = [
      "worker-and-site", "wildcard-ssl", "per-slug-ssl",
      "primary-frontend", "deploy-and-verify", "sync-scripts", "all",
    ];
    for (const action of probeActions) {
      try {
        const r = await fetch(`${sandboxUrl}/admin/repair`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-sandbox-secret": secret, "x-pluto-diagnose": "1" },
          body: JSON.stringify({
            action,
            slug: "__diagnose_no_op__",
            wildcard: "invalid.local",
            acmeEmail: "diagnose@invalid.local",
            dryRun: true,
          }),
        });
        const text = await r.text();
        const wired = r.status !== 404 && r.status !== 502 && r.status !== 503 && r.status !== 0;
        out.actions.push({
          action,
          wired,
          status: r.status,
          detail: wired
            ? `wired (HTTP ${r.status})`
            : r.status === 404
              ? "action not accepted by wrapper — update pluto-repair"
              : r.status === 502 || r.status === 503
                ? "worker unreachable through nginx"
                : `HTTP ${r.status}: ${text.slice(0, 120)}`,
        });
      } catch (e) {
        out.actions.push({ action, wired: false, status: 0, detail: (e as Error).message });
      }
    }

    if (!out.worker.ok) out.hint = "Sandbox worker /healthz is unreachable. Repair endpoints will fail. Run repair-sandbox-worker.sh on VPS.";
    else if (!out.wrapperInstalled.ok) out.hint = "The /admin/repair wrapper is not installed or not sudo-authorized. Rerun full-deploy.sh on the VPS.";
    else if (out.actions.some((a) => !a.wired)) out.hint = "Some repair actions are not accepted by the installed wrapper — pull latest and rerun full-deploy.sh on the VPS.";
    return out;
  });

// ---- Live primary-frontend header verification (curl -I equivalent) ---------
// Called after each Auto Deploy to give a red/green status of whether the
// primary vhost is actually routing (X-Pluto-Primary header is stamped) at
// app.timescard.cloud. Also usable ad-hoc from any panel.

export type PrimaryVerifyResult = {
  ok: boolean;                // true only if HTTP 2xx AND x-pluto-primary is present
  url: string;
  status: number;             // 0 on network failure
  durationMs: number;
  server: string | null;
  primaryHeader: string | null;   // value of x-pluto-primary, or null
  releaseHeader: string | null;   // value of x-pluto-release, or null
  contentType: string | null;
  bodyPreview: string;        // first ~240 bytes of GET body (for red-flag diagnosis)
  headers: Record<string, string>;
  hint: string | null;
  checkedAt: string;
};

const VerifyInput = z.object({
  url: z.string().url().max(253).optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  slug: z.string().max(128).optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
});

export const verifyPrimaryLive = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => VerifyInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<PrimaryVerifyResult> => {
    const url = (data.url || envFirst("PLUTO_PRIMARY_FRONTEND_URL") || "https://app.timescard.cloud").replace(/\/+$/, "") + "/";
    const t0 = Date.now();
    const checkedAt = new Date().toISOString();
    try {
      // GET (not HEAD) — some nginx setups skip custom headers on HEAD, and
      // we want a body preview to detect "marketing app still routed" cases.
      const r = await fetch(url, { redirect: "manual" });
      const buf = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
      const body = new TextDecoder().decode(buf).slice(0, 240);
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      const primaryHeader = r.headers.get("x-pluto-primary");
      const releaseHeader = r.headers.get("x-pluto-release");
      const ok = r.ok && !!primaryHeader && primaryHeader.length > 0;
      let hint: string | null = null;
      if (!r.ok) {
        hint = r.status === 0 ? "DNS or network failure — verify wildcard DNS points to the VPS."
             : r.status === 502 || r.status === 503 ? "nginx is up but the upstream is not — run One-click Fix → Repair worker + site."
             : `HTTP ${r.status} from ${url} — check nginx vhost.`;
      } else if (!primaryHeader) {
        hint = `${url} returned HTTP ${r.status} but the primary vhost is not routing (no X-Pluto-Primary header). Run One-click Fix → Activate primary frontend${data.slug ? ` with slug '${data.slug}'` : ""}.`;
      }
      return {
        ok, url, status: r.status, durationMs: Date.now() - t0,
        server: r.headers.get("server"),
        primaryHeader, releaseHeader,
        contentType: r.headers.get("content-type"),
        bodyPreview: body, headers, hint, checkedAt,
      };
    } catch (e) {
      return {
        ok: false, url, status: 0, durationMs: Date.now() - t0,
        server: null, primaryHeader: null, releaseHeader: null,
        contentType: null, bodyPreview: "", headers: {},
        hint: `Network failure reaching ${url}: ${(e as Error).message}. Check DNS + nginx.`,
        checkedAt,
      };
    }
  });
