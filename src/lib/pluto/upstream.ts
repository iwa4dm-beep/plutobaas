// Shared upstream API client for the Pluto self-hosted admin pages.
// Reads URL + JWT stored by dashboard.pluto-admin.tsx.

const LS_URL   = "pluto.upstream.url";
const LS_TOKEN = "pluto.upstream.token";
const LS_HIST  = "pluto.ui.history";

export function getUpstream() {
  if (typeof window === "undefined") return { url: "", token: "", configured: false };
  const url = localStorage.getItem(LS_URL) ?? "";
  const token = localStorage.getItem(LS_TOKEN) ?? "";
  return { url, token, configured: url.length > 0 && token.length > 0 };
}

export async function plutoApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, token } = getUpstream();
  if (!url) throw new Error("Pluto upstream URL not configured. Set it on the Pluto Admin page.");
  const res = await fetch(`${url.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err: any = new Error(data?.message || data?.error || res.statusText);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data as T;
}

// ------------- Client-side UI history (last 100 admin actions) -------------

export type UiHistoryEntry = {
  ts: string;
  action: string;
  detail?: string;
  ok: boolean;
};

export function pushUiHistory(entry: Omit<UiHistoryEntry, "ts">) {
  if (typeof window === "undefined") return;
  const list = readUiHistory();
  list.unshift({ ts: new Date().toISOString(), ...entry });
  localStorage.setItem(LS_HIST, JSON.stringify(list.slice(0, 100)));
}

export function readUiHistory(): UiHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(LS_HIST) ?? "[]"); } catch { return []; }
}

export function clearUiHistory() {
  if (typeof window !== "undefined") localStorage.removeItem(LS_HIST);
}
