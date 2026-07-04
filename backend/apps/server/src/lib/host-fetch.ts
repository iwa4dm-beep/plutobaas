// Phase 55 — Host fetch for WASM edge functions.
// Enforces per-workspace allowlist, method/scheme/size limits, and returns a
// normalized response envelope. Real WASM host imports would call this from
// inside the guest via a linker-provided function; the shim keeps it callable
// from tests and HTTP endpoints alike.

export type HostFetchInput = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body_base64?: string;
  timeout_ms?: number;
};

export type HostFetchResult = {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body_base64: string;
  bytes: number;
};

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const BLOCKED_HEADERS = new Set(["host", "content-length"]);

// Per-workspace allowlist of hostname suffixes. `*` allows anything.
const allowlist = new Map<string, Set<string>>();

export function setAllowlist(workspace: string, hosts: string[]): void {
  allowlist.set(workspace, new Set(hosts.map((h) => h.toLowerCase())));
}

export function isAllowed(workspace: string, hostname: string): boolean {
  const set = allowlist.get(workspace);
  if (!set || set.has("*")) return set !== undefined; // requires an explicit `*` opt-in
  const h = hostname.toLowerCase();
  for (const suffix of set) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

export async function hostFetch(workspace: string, input: HostFetchInput,
  fetchImpl: typeof fetch = fetch): Promise<HostFetchResult> {
  let url: URL;
  try { url = new URL(input.url); } catch { throw new Error("invalid_url"); }
  if (url.protocol !== "https:") throw new Error("scheme_forbidden");
  if (!isAllowed(workspace, url.hostname)) throw new Error("host_not_allowed");

  const headers = new Headers();
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (!BLOCKED_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }

  const body = input.body_base64 ? Buffer.from(input.body_base64, "base64") : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url.toString(), {
      method: input.method ?? "GET", headers, body, signal: controller.signal,
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BODY_BYTES) throw new Error("response_too_large");
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { outHeaders[k] = v; });
    return {
      ok: res.ok, status: res.status, headers: outHeaders,
      body_base64: Buffer.from(buf).toString("base64"), bytes: buf.byteLength,
    };
  } finally { clearTimeout(timer); }
}

export function clearAllowlists(): void { allowlist.clear(); }
