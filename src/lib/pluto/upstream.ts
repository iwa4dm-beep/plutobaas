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

// Best-effort read of the workspace anon/publishable key used for the
// `apikey` header (mirrors src/lib/pluto/live.ts). Kept optional — if we
// can't read it, the request still works when the bearer token is valid.
function readAnonKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return (
      // Preferred: workspace config baked into the SPA at build time.
      (import.meta.env.VITE_PLUTO_ANON_KEY as string | undefined) ||
      localStorage.getItem("pluto.anon.key") ||
      ""
    );
  } catch { return ""; }
}

export function getUpstream() {
  if (typeof window === "undefined") return { url: PROXY_BASE, token: "", configured: true };
  const stored = localStorage.getItem(LS_URL) ?? "";
  // Prefer the fresh Supabase-style session token; only fall back to the
  // legacy operator-pasted token when no session exists. A stale legacy
  // token signed with a rotated PLUTO_JWT_SECRET was surfacing as
  // "Authorization token is invalid: The token signature is invalid."
  const session = readSessionToken();
  const legacy  = localStorage.getItem(LS_TOKEN) ?? "";
  const token   = session || legacy;
  const url     = stored || PROXY_BASE; // same-origin proxy by default
  return { url, token, configured: url.length > 0 };
}

export async function plutoApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, token } = getUpstream();
  const base = (url || PROXY_BASE).replace(/\/+$/, "");
  const apikey = readAnonKey();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(apikey ? { apikey } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  const d = data && typeof data === "object" ? data as { message?: string; error?: string; reason?: string; offline?: boolean; code?: string } : null;
  // Auto-recover from a stale legacy token: if the backend says the JWT
  // signature is invalid AND we're currently using the legacy token, purge
  // it and retry once with the fresh session token (or unauthenticated).
  if (res.status === 401 && d?.code === "FST_JWT_AUTHORIZATION_TOKEN_INVALID" && token && token === localStorage.getItem(LS_TOKEN)) {
    localStorage.removeItem(LS_TOKEN);
    const fresh = readSessionToken();
    const retryRes = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(apikey ? { apikey } : {}),
        ...(fresh ? { Authorization: `Bearer ${fresh}` } : {}),
        ...(init.headers || {}),
      },
    });
    const retryText = await retryRes.text();
    let retryData: unknown = null;
    try { retryData = retryText ? JSON.parse(retryText) : null; } catch { retryData = retryText; }
    if (retryRes.ok) return retryData as T;
    const rd = retryData && typeof retryData === "object" ? retryData as { message?: string; error?: string } : null;
    const rerr = new Error(rd?.message || rd?.error || retryRes.statusText) as Error & { status?: number; body?: unknown };
    rerr.status = retryRes.status;
    rerr.body = retryData;
    throw rerr;
  }
  if (!res.ok || d?.offline) {
    const err = new Error(d?.message || d?.error || res.statusText) as Error & { status?: number; body?: unknown };
    err.message = d?.message || d?.error || d?.reason || res.statusText || "Pluto backend offline";
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
