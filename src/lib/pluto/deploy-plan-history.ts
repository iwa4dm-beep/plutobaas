// LocalStorage-backed history of AI deploy plans + VPS guides.
// Kept client-side to avoid enabling Cloud just for audit trails.
import type { DeployPlan, VpsGuide } from "@/lib/pluto/ai-deploy-planner.functions";

const KEY = "pluto:deploy-plan-history:v1";
const MAX = 25;

export type PlanHistoryEntry = {
  id: string;
  createdAt: string; // ISO
  workspaceId: string;
  domain?: string;
  plan: DeployPlan;
  guide?: VpsGuide;
  note?: string;
};

function safeLoad(): PlanHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as PlanHistoryEntry[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function safeSave(entries: PlanHistoryEntry[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX)));
  } catch { /* quota — silently ignore */ }
}

export function listPlanHistory(): PlanHistoryEntry[] {
  return safeLoad().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function savePlan(entry: Omit<PlanHistoryEntry, "id" | "createdAt">): PlanHistoryEntry {
  const full: PlanHistoryEntry = {
    ...entry,
    id: `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  const next = [full, ...safeLoad()].slice(0, MAX);
  safeSave(next);
  return full;
}

export function attachGuide(planId: string, guide: VpsGuide) {
  const list = safeLoad();
  const idx = list.findIndex((e) => e.id === planId);
  if (idx === -1) return;
  list[idx] = { ...list[idx], guide };
  safeSave(list);
}

export function deletePlan(id: string) {
  safeSave(safeLoad().filter((e) => e.id !== id));
}

export function clearPlanHistory() {
  safeSave([]);
}
