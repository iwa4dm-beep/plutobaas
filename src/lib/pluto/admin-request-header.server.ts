/**
 * SERVER-ONLY implementation of the incoming-auth-header store.
 *
 * This file imports `@tanstack/react-start/server` and `node:async_hooks`,
 * so it must NEVER be reachable from a client bundle. Two guards enforce
 * that:
 *   1. the `.server.ts` filename (blocked by Vite import-protection), and
 *   2. `scripts/check-server-imports.mjs` + the eslint `no-restricted-imports`
 *      rule, which forbid `@tanstack/react-start/server` anywhere else.
 *
 * Client-safe callers must go through `./request-context` (createServerOnlyFn
 * wrapper) instead of importing this module directly.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getRequestHeader } from "@tanstack/react-start/server";

const store = new AsyncLocalStorage<{ header: string }>();

/**
 * Returns the caller's Authorization header, or `null`.
 *
 * Safe fallback: when there is no active request context (prerender, a
 * background job, a nested call outside the request ALS), this logs a clear
 * message and returns `null` instead of throwing, so rendering never breaks.
 */
export function readIncomingAuthHeader(): string | null {
  const fromStore = store.getStore()?.header;
  if (fromStore) return fromStore;
  try {
    const h = getRequestHeader("authorization");
    if (!h) {
      console.warn(
        "[pluto-auth] request-context: no Authorization header on the current request — continuing without a recovered token.",
      );
      return null;
    }
    return h;
  } catch (err) {
    console.warn(
      "[pluto-auth] request-context unavailable (no active server request context). " +
        "Falling back to no auth header; this is expected during SSR prerender or background jobs.",
      { reason: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
}

export function runWithAuthHeader<T>(header: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ header }, fn);
}
