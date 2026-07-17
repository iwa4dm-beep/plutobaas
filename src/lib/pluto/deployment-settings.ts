// Per-workspace Auto-Deploy settings, persisted in localStorage.
// Superset of the legacy keys pluto:servedSiteUrl / pluto:servedSiteUrlTemplate /
// pluto:strictServedSite — legacy keys stay in sync so existing wiring works.

export type DeploymentSettings = {
  autoDeployOnPush: boolean;
  strictServedSite: boolean;
  strictSsl: boolean;
  servedSiteUrl: string;
  servedSiteUrlTemplate: string;
  notifyEmail: string;
  defaultBranch: string;
};

export const DEFAULT_SETTINGS: DeploymentSettings = {
  autoDeployOnPush: false,
  strictServedSite: true,
  strictSsl: false,
  servedSiteUrl: "",
  servedSiteUrlTemplate: "https://{slug}.app.timescard.cloud",
  notifyEmail: "",
  defaultBranch: "main",
};

const LEGACY_KEYS = {
  servedSiteUrl: "pluto:servedSiteUrl",
  servedSiteUrlTemplate: "pluto:servedSiteUrlTemplate",
  strictServedSite: "pluto:strictServedSite",
} as const;

function scopedKey(workspaceId: string): string {
  return `pluto:deployment-settings:${workspaceId || "root"}`;
}

export function loadDeploymentSettings(workspaceId: string): DeploymentSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  const merged: DeploymentSettings = { ...DEFAULT_SETTINGS };

  // Legacy fallbacks (global) — used when workspace copy is absent.
  try {
    merged.servedSiteUrl = window.localStorage.getItem(LEGACY_KEYS.servedSiteUrl) ?? merged.servedSiteUrl;
    merged.servedSiteUrlTemplate = window.localStorage.getItem(LEGACY_KEYS.servedSiteUrlTemplate) ?? merged.servedSiteUrlTemplate;
    const legacyStrict = window.localStorage.getItem(LEGACY_KEYS.strictServedSite);
    if (legacyStrict != null) merged.strictServedSite = legacyStrict === "1";
  } catch { /* ignore */ }

  try {
    const raw = window.localStorage.getItem(scopedKey(workspaceId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DeploymentSettings>;
      Object.assign(merged, parsed);
    }
  } catch { /* ignore */ }
  if (!merged.servedSiteUrlTemplate.trim()) {
    merged.servedSiteUrlTemplate = DEFAULT_SETTINGS.servedSiteUrlTemplate;
  }
  return merged;
}

export function saveDeploymentSettings(workspaceId: string, settings: DeploymentSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(scopedKey(workspaceId), JSON.stringify(settings));
    // Mirror to legacy keys so existing state readers stay in sync.
    window.localStorage.setItem(LEGACY_KEYS.servedSiteUrl, settings.servedSiteUrl);
    window.localStorage.setItem(LEGACY_KEYS.servedSiteUrlTemplate, settings.servedSiteUrlTemplate);
    window.localStorage.setItem(LEGACY_KEYS.strictServedSite, settings.strictServedSite ? "1" : "0");
    window.dispatchEvent(new CustomEvent("pluto:deployment-settings:changed", { detail: { workspaceId } }));
  } catch { /* ignore */ }
}

export function validateNotifyEmail(email: string): string | null {
  const v = email.trim();
  if (!v) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "Invalid email address";
  return null;
}
