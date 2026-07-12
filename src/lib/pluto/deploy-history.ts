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
};

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
