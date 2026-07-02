/**
 * Minimal typed fetch helper for the CLI.
 *
 * Adds the standard Pluto headers (workspace, anon/service keys, bearer)
 * and surfaces backend errors as `Error` with the API-provided message so
 * command handlers can just `throw`.
 */
import { fetch } from "undici";

export type FetchOpts = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  token?: string;         // user bearer
  serviceKey?: string;    // service_role
  anonKey?: string;
  workspace?: string;
  body?: unknown;
  timeoutMs?: number;
};

export async function plutoFetch<T = unknown>(base: string, path: string, opts: FetchOpts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token)      headers.authorization = `Bearer ${opts.token}`;
  if (opts.anonKey)    headers.apikey = opts.anonKey;
  if (opts.serviceKey) headers.apikey = opts.serviceKey;
  if (opts.workspace)  headers["x-workspace-id"] = opts.workspace;
  if (opts.body != null) headers["content-type"] = "application/json";

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    const parsed: unknown = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = typeof parsed === "object" && parsed && "error" in parsed && typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `HTTP ${res.status}`;
      throw new Error(`${opts.method ?? "GET"} ${path} → ${msg}`);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }
