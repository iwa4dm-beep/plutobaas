// LocalStorage-backed environment presets (domain + VPS IP + optional workspace).
// Lets a user save multiple targets and reuse them across workspaces.
const KEY = "pluto:env-presets:v1";
const MAX = 20;

export type EnvPreset = {
  id: string;
  name: string;
  domain: string;
  vpsIp?: string;
  workspaceId?: string;
  createdAt: string;
};

function load(): EnvPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as EnvPreset[];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function save(list: EnvPreset[]) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* quota */ }
}

export function listPresets(): EnvPreset[] {
  return load().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function savePreset(entry: Omit<EnvPreset, "id" | "createdAt">): EnvPreset {
  const full: EnvPreset = {
    ...entry,
    id: `env_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
  };
  save([full, ...load()].slice(0, MAX));
  return full;
}

export function deletePreset(id: string) {
  save(load().filter((e) => e.id !== id));
}
