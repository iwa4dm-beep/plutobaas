/**
 * Base-URL resolver used across the dashboard for building copy-pasteable
 * snippets (SDK setup, cURL, webhook targets, …).
 *
 * Priority (highest wins):
 *   1. Per-workspace override saved via `setWorkspaceBaseUrl()` — usually
 *      the verified custom domain the tenant configured under
 *      Dashboard → Custom domains.
 *   2. `VITE_STAGING_BASE_URL` when the app is served from a Lovable
 *      staging/preview host (id-preview--*, *-staging.lovable.app).
 *   3. `VITE_BASE_URL` in every other browser context.
 *   4. `window.location.origin` as a last resort so the value is never
 *      empty in local dev.
 *   5. `VITE_PLUTO_URL` (backend API URL) is used only when the resolver
 *      is asked for the API endpoint, not the dashboard URL.
 */

const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
const STORAGE_PREFIX = "pluto.workspace.base_url.";

function isStagingHost(host: string): boolean {
  return (
    host.startsWith("id-preview--") ||
    host.endsWith("-staging.lovable.app") ||
    host.endsWith(".lovable.dev")
  );
}

/** URL where the dashboard itself is (or should be) served. */
export function resolveDashboardUrl(): string {
  if (typeof window === "undefined") {
    return env.VITE_BASE_URL ?? "";
  }
  if (isStagingHost(window.location.host) && env.VITE_STAGING_BASE_URL) {
    return stripSlash(env.VITE_STAGING_BASE_URL);
  }
  if (env.VITE_BASE_URL) return stripSlash(env.VITE_BASE_URL);
  return stripSlash(window.location.origin);
}

/** Public URL that end-user browsers should call to reach the backend API. */
export function resolveApiUrl(workspaceId?: string | null): string {
  const override = workspaceId ? readWorkspaceOverride(workspaceId) : null;
  if (override) return stripSlash(override);
  return stripSlash(env.VITE_PLUTO_URL ?? resolveDashboardUrl());
}

export function setWorkspaceBaseUrl(workspaceId: string, url: string | null): void {
  if (typeof localStorage === "undefined") return;
  const key = STORAGE_PREFIX + workspaceId;
  if (!url) localStorage.removeItem(key);
  else localStorage.setItem(key, stripSlash(url));
}

export function getWorkspaceBaseUrl(workspaceId: string): string | null {
  return readWorkspaceOverride(workspaceId);
}

function readWorkspaceOverride(workspaceId: string): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(STORAGE_PREFIX + workspaceId);
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, "");
}
