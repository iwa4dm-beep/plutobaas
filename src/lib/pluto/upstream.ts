// Shared upstream API client for the Pluto self-hosted admin pages.
//
// Historically these pages required the operator to paste an upstream URL
// and JWT into the "Pluto Admin" page (stored in localStorage). That gave a
// confusing "Pluto upstream URL not configured…" error the moment a user
// opened any pluto-* page on a fresh install. The dashboard now ships with
// a same-origin `/api/pluto/*` proxy that forwards to the configured
// backend using the signed-in session, so plutoApi transparently falls
// back to that when nothing is in localStorage.

const LS_URL   = "pluto.upstream.url";
const LS_TOKEN = "pluto.upstream.token";
const LS_HIST  = "pluto.ui.history";

const SESSION_KEY = "pluto.session.v1";
const PROXY_BASE  = "/api/pluto";

function readSessionToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return "";
    const s = JSON.parse(raw) as { access_token?: string };
    return s.access_token ?? "";
  } catch { return ""; }
}

export function getUpstream() {
  if (typeof window === "undefined") return { url: PROXY_BASE, token: "", configured: true };
  const stored = localStorage.getItem(LS_URL) ?? "";
  const token  = localStorage.getItem(LS_TOKEN) ?? readSessionToken();
  const url    = stored || PROXY_BASE; // same-origin proxy by default
  return { url, token, configured: url.length > 0 };
}

export async function plutoApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, token } = getUpstream();
  const base = (url || PROXY_BASE).replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const d = data as { message?: string; error?: string } | null;
    const err = new Error(d?.message || d?.error || res.statusText) as Error & { status?: number; body?: unknown };
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
