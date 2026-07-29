/**
 * Client-safe façade over the server-only request-context helpers.
 *
 * `createServerOnlyFn` guarantees the wrapped body only ever executes on the
 * server — and because the `@tanstack/react-start/server` import lives behind
 * a dynamic `import()` of a `*.server.ts` module, nothing server-only is
 * pulled into a client bundle at module scope.
 *
 * Both functions degrade gracefully: if the request context is missing they
 * log a clear message and return a neutral value instead of throwing, so a
 * missing context can never blank a page.
 */
import { createServerOnlyFn } from "@tanstack/react-start";

/** Read the incoming Authorization header. Returns null when unavailable. */
export const readIncomingAuthHeader = createServerOnlyFn(
  async (): Promise<string | null> => {
    try {
      const mod = await import("./admin-request-header.server");
      return mod.readIncomingAuthHeader();
    } catch (err) {
      console.warn(
        "[pluto-auth] request-context module unavailable — skipping auth-header recovery.",
        { reason: err instanceof Error ? err.message : String(err) },
      );
      return null;
    }
  },
);

/**
 * Run `fn` with `header` stashed in AsyncLocalStorage so nested server-fn
 * calls can recover it. If the store cannot be set up, `fn` still runs.
 */
export const runWithAuthHeader = createServerOnlyFn(
  async <T,>(header: string, fn: () => Promise<T>): Promise<T> => {
    try {
      const mod = await import("./admin-request-header.server");
      return await mod.runWithAuthHeader(header, fn);
    } catch (err) {
      console.warn(
        "[pluto-auth] could not establish request-scoped auth store — continuing without it.",
        { reason: err instanceof Error ? err.message : String(err) },
      );
      return await fn();
    }
  },
);
