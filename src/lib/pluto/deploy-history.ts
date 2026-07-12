// Client-side deployment history persisted in localStorage.
// Keeps last 50 attempts across sessions.
import type { StepDebug } from "@/lib/pluto/vps-deployer.functions";

const KEY = "pluto:deploy-history";
const MAX = 50;

export type HistoryStep = {
  key: "sql" | "upload" | "verify";
  label: string;
  state: "ok" | "error" | "skipped";
  detail?: string;
  debug: StepDebug | null;
};

export type HistoryEntry = {
  id: string;
  timestamp: number;
  workspaceId: string;
  overallOk: boolean;
  steps: HistoryStep[];
  /** SQL used for the migration step, persisted so we can redeploy later. */
  sql?: string;
  /** Bundle filename shown in UI (Blob itself is not persisted). */
  bundleName?: string;
};

// ---------- Redeploy prefill ----------
// Bundle Blobs can't survive a full reload / storage round-trip, so we only
// carry SQL + workspaceId + bundleName across the redeploy hop. The user is
// prompted to re-select the bundle when it's required.
const REDEPLOY_KEY = "pluto:deploy-redeploy-prefill";
export type RedeployPrefill = { workspaceId: string; sql?: string; bundleName?: string };

export function setRedeployPrefill(p: RedeployPrefill): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(REDEPLOY_KEY, JSON.stringify(p));
}
export function consumeRedeployPrefill(): RedeployPrefill | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(REDEPLOY_KEY);
  if (!raw) return null;
  window.sessionStorage.removeItem(REDEPLOY_KEY);
  try { return JSON.parse(raw) as RedeployPrefill; } catch { return null; }
}

export function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveHistoryEntry(entry: HistoryEntry): void {
  if (typeof window === "undefined") return;
  const all = [entry, ...loadHistory()].slice(0, MAX);
  window.localStorage.setItem(KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent("pluto:deploy-history:changed"));
}

export function clearHistory(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
  window.dispatchEvent(new CustomEvent("pluto:deploy-history:changed"));
}

// ---------- Download ----------
export function downloadEntryAsJson(entry: HistoryEntry, filename?: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([JSON.stringify(entry, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename ?? `deployment-${entry.workspaceId}-${new Date(entry.timestamp).toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Compare ----------
export type StepDiff = {
  key: HistoryStep["key"];
  label: string;
  left: HistoryStep | null;
  right: HistoryStep | null;
  stateChanged: boolean;
  latencyDeltaMs: number | null;
  statusChanged: boolean;
  reqBodyChanged: boolean;
  resBodyChanged: boolean;
};

export type DeploymentDiff = {
  workspaceChanged: boolean;
  overallChanged: boolean;
  steps: StepDiff[];
};

export function compareEntries(left: HistoryEntry, right: HistoryEntry): DeploymentDiff {
  const keys: HistoryStep["key"][] = ["sql", "upload", "verify"];
  const steps: StepDiff[] = keys.map((k) => {
    const l = left.steps.find((s) => s.key === k) ?? null;
    const r = right.steps.find((s) => s.key === k) ?? null;
    const latencyDelta =
      l?.debug && r?.debug ? r.debug.latencyMs - l.debug.latencyMs : null;
    return {
      key: k,
      label: l?.label ?? r?.label ?? k,
      left: l,
      right: r,
      stateChanged: (l?.state ?? null) !== (r?.state ?? null),
      latencyDeltaMs: latencyDelta,
      statusChanged: (l?.debug?.status ?? null) !== (r?.debug?.status ?? null),
      reqBodyChanged: (l?.debug?.reqBodyPreview ?? null) !== (r?.debug?.reqBodyPreview ?? null),
      resBodyChanged: (l?.debug?.resBodyPreview ?? null) !== (r?.debug?.resBodyPreview ?? null),
    };
  });
  return {
    workspaceChanged: left.workspaceId !== right.workspaceId,
    overallChanged: left.overallOk !== right.overallOk,
    steps,
  };
}
