// Server function that probes the VPS backend and returns a compact health
// report the dashboard can render. Uses no auth — hits public health paths.
import { createServerFn } from "@tanstack/react-start";
import { getVpsBaseUrl } from "./vps-client";

export type VpsHealthProbe = {
  path: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  body?: string;
  error?: string;
};

export type VpsHealthReport = {
  baseUrl: string;
  checkedAt: string;
  serviceKeyConfigured: boolean;
  probes: VpsHealthProbe[];
  healthy: boolean;
};

export type ActiveSubdomain = {
  host: string;
  slug: string;
  url: string;
  ok: boolean;
  nginx: { enabled: boolean; available: boolean; wildcardEnabled?: boolean; wildcardAvailable?: boolean };
  worker: { ok: boolean; ready: boolean; channel: string | null; servedAt: string | null; error: string | null };
  http: { status: number; latencyMs: number; error?: string };
  https: { status: number; latencyMs: number; error?: string };
  ssl: { valid: boolean; cn: string | null; expiry: string | null; daysLeft: number | null; hostnameMatch: boolean; warning: string | null };
  issues: string[];
};

export type ActiveSubdomainsReport = {
  ok: boolean;
  baseDomain: string;
  checkedAt: string;
  count: number;
  summary: { ready: number; nginxEnabled: number; sslValid: number; expiringSoon: number; broken: number };
  subdomains: ActiveSubdomain[];
  error?: string;
  hint?: string;
};

function envFirst(...keys: string[]): string {
  for (const key of keys) {
    const v = process.env[key];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

async function probe(base: string, path: string): Promise<VpsHealthProbe> {
  const started = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    let body: string | undefined;
    try {
      const text = await res.text();
      body = text ? text.slice(0, 500) : undefined;
    } catch { /* ignore */ }
    return { path, ok: res.ok, status: res.status, latencyMs: Date.now() - started, body };
  } catch (e) {
    return {
      path, ok: false, status: 0, latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export const checkVpsHealth = createServerFn({ method: "GET" }).handler(async (): Promise<VpsHealthReport> => {
  const base = getVpsBaseUrl();
  const paths = ["/livez", "/readyz", "/health/deps", "/"];
  const probes = await Promise.all(paths.map((p) => probe(base, p)));
  return {
    baseUrl: base,
    checkedAt: new Date().toISOString(),
    serviceKeyConfigured: Boolean(process.env.PLUTO_SERVICE_ROLE_KEY),
    probes,
    healthy: probes.filter((p) => p.path !== "/").every((p) => p.ok),
  };
});

export async function fetchActiveSubdomains(baseDomain?: string): Promise<ActiveSubdomainsReport> {
  const base = getVpsBaseUrl();
  const sandboxUrl = (envFirst("PLUTO_SANDBOX_URL") || `${base}/sandbox`).replace(/\/+$/, "");
  const secret = envFirst("PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET");
  const domain = (baseDomain || process.env.PLUTO_WILDCARD_HOST || "app.timescard.app").replace(/^\*\./, "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!secret) {
    return {
      ok: false,
      baseDomain: domain,
      checkedAt: new Date().toISOString(),
      count: 0,
      summary: { ready: 0, nginxEnabled: 0, sslValid: 0, expiringSoon: 0, broken: 0 },
      subdomains: [],
      error: "sandbox_secret_missing",
      hint: "PLUTO_SANDBOX_SECRET is not configured. Run print-sandbox-secret.sh on the VPS and add the value to project secrets.",
    };
  }

  const url = `${sandboxUrl}/admin/subdomains?baseDomain=${encodeURIComponent(domain)}`;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "x-sandbox-secret": secret },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        baseDomain: domain,
        checkedAt: new Date().toISOString(),
        count: 0,
        summary: { ready: 0, nginxEnabled: 0, sslValid: 0, expiringSoon: 0, broken: 0 },
        subdomains: [],
        error: `HTTP ${res.status}`,
        hint: res.status === 404
          ? "VPS worker is older and does not expose /admin/subdomains yet. Run full-deploy.sh on the VPS."
          : text.slice(0, 300),
      };
    }
    return JSON.parse(text) as ActiveSubdomainsReport;
  } catch (e) {
    return {
      ok: false,
      baseDomain: domain,
      checkedAt: new Date().toISOString(),
      count: 0,
      summary: { ready: 0, nginxEnabled: 0, sslValid: 0, expiringSoon: 0, broken: 0 },
      subdomains: [],
      error: e instanceof Error ? e.message : String(e),
      hint: "Could not reach the sandbox worker through the VPS API domain.",
    };
  }
}

export const getActiveSubdomains = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => {
    const v = (d && typeof d === "object" && "baseDomain" in d) ? String((d as { baseDomain?: unknown }).baseDomain ?? "") : "";
    return { baseDomain: v.slice(0, 253) };
  })
  .handler(async ({ data }): Promise<ActiveSubdomainsReport> => fetchActiveSubdomains(data.baseDomain || undefined));
