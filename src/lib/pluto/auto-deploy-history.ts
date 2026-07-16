// Persistent history for Auto-Deploy Studio runs (localStorage-backed).
// Bundle bytes are NOT persisted (too large / not JSON-safe); only metadata
// + SQL + serialized step logs are kept. In-memory `lastSuccess` on the
// page holds bytes for same-session rollback.
import type { DeployAllResult } from "@/lib/pluto/vps-deployer.functions";

const KEY = "pluto:auto-deploy-history";
const MAX = 25;

export type AutoDeployHistoryEntry = {
  id: string;
  timestamp: number;
  workspaceId: string;
  slug: string;
  source: "github" | "giturl" | "zip";
  sourceRef: string;                 // repo, git url, or zip filename
  ok: boolean;
  totalMs: number;
  liveUrl: string | null;
  tables: number;
  routes: number;
  bundlePath: string;
  sqlPreview: string;                // first ~2 KB of SQL for display
  envKeys: string[];                 // just the keys (values redacted)
  steps: Array<{ key: string; label: string; ok: boolean; attempts: number; detail: string }>;
  health: HealthSummary | null;
  isRollback?: boolean;
};

export type EndpointCheck = {
  label: string;
  url: string;
  method: string;
  status: number;
  latencyMs: number;
  ok: boolean;
  bodySnippet: string;
  failReason?: string;
};

export type HealthSummary = {
  endpoints: EndpointCheck[];
  overallOk: boolean;
};

export function loadAutoDeployHistory(): AutoDeployHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveAutoDeployEntry(entry: AutoDeployHistoryEntry): void {
  if (typeof window === "undefined") return;
  const all = [entry, ...loadAutoDeployHistory()].slice(0, MAX);
  window.localStorage.setItem(KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent("pluto:auto-deploy-history:changed"));
}

export function clearAutoDeployHistory(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
  window.dispatchEvent(new CustomEvent("pluto:auto-deploy-history:changed"));
}

/** Parse the health-check step out of a DeployAllResult into an endpoint table. */
export function extractHealth(result: DeployAllResult): HealthSummary | null {
  const step = result.steps.find((s) => s.key === "health-check");
  if (!step || !step.result) return null;
  let parsed: {
    runtime?: { status: number; body: string };
    invoke?: { status: number; body: string };
    site?: { status: number; url: string; snippet: string } | null;
  } = {};
  try { parsed = JSON.parse(step.result); } catch { return null; }

  const lastAttempt = step.attempts.at(-1);
  const runtimeLatency = lastAttempt?.debug?.latencyMs ?? lastAttempt?.latencyMs ?? 0;
  const liveUrls = result.liveUrls;

  const endpoints: EndpointCheck[] = [];
  if (parsed.runtime && liveUrls) {
    const ok = parsed.runtime.status >= 200 && parsed.runtime.status < 400;
    endpoints.push({
      label: "Functions runtime",
      url: liveUrls.functionsHealth,
      method: "GET",
      status: parsed.runtime.status,
      latencyMs: runtimeLatency,
      ok,
      bodySnippet: parsed.runtime.body,
      failReason: ok ? undefined : deriveFailReason(parsed.runtime.status, parsed.runtime.body),
    });
  }
  if (parsed.invoke && liveUrls) {
    const ok = parsed.invoke.status >= 200 && parsed.invoke.status < 400;
    endpoints.push({
      label: "Bootstrap function invoke",
      url: liveUrls.bootstrapInvoke,
      method: "POST",
      status: parsed.invoke.status,
      latencyMs: 0,
      ok,
      bodySnippet: parsed.invoke.body,
      failReason: ok ? undefined : deriveFailReason(parsed.invoke.status, parsed.invoke.body),
    });
  }
  if (parsed.site) {
    const ok = parsed.site.status >= 200 && parsed.site.status < 400;
    endpoints.push({
      label: "Served site",
      url: parsed.site.url,
      method: "GET",
      status: parsed.site.status,
      latencyMs: 0,
      ok,
      bodySnippet: parsed.site.snippet,
      failReason: ok ? undefined : deriveFailReason(parsed.site.status, parsed.site.snippet),
    });
  }
  return { endpoints, overallOk: endpoints.every((e) => e.ok) };
}

function deriveFailReason(status: number, body: string): string {
  if (status === 0) return "Network error / timeout — endpoint unreachable";
  if (status === 401 || status === 403) return "Unauthorized — service key or JWT invalid";
  if (status === 404) return "Endpoint not found — service may not be registered";
  if (status === 429) return "Rate-limited by upstream";
  if (status >= 500) return `Upstream ${status} — ${body.slice(0, 100)}`;
  return `HTTP ${status}`;
}
