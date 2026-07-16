// E2E-style unit test for the JWT-rotation self-healing path in plutoApi.
//
// Scenario: operator rotated PLUTO_JWT_SECRET on the backend. The browser
// still has the old operator-pasted token in localStorage
// (`pluto.upstream.token`) alongside a fresh Supabase-style session token
// in `pluto.session.v1`. First plutoApi call must:
//   1. attempt with the stale legacy token and receive 401
//      FST_JWT_AUTHORIZATION_TOKEN_INVALID,
//   2. purge the stale legacy token from localStorage,
//   3. retry once with the fresh session access_token,
//   4. return the 200 payload transparently to the caller.
//
// Root vitest env is "node" — install a minimal window+localStorage shim
// on globalThis before importing the module under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return Array.from(this.m.keys())[i] ?? null; }
}
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

const { plutoApi } = await import("./upstream");

const LS_TOKEN   = "pluto.upstream.token";
const LS_URL     = "pluto.upstream.url";
const SESSION_KEY = "pluto.session.v1";

const STALE = "stale.legacy.jwt";
const FRESH = "fresh.session.jwt";

function seedRotationScenario() {
  localStorage.clear();
  localStorage.setItem(LS_TOKEN, STALE);
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ access_token: FRESH, token_type: "bearer" }),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("plutoApi — JWT rotation self-healing (database-import scenario)", () => {
  beforeEach(() => {
    seedRotationScenario();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("purges stale legacy token and retries with the fresh session token on FST_JWT_AUTHORIZATION_TOKEN_INVALID", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      if (auth === `Bearer ${STALE}`) {
        return jsonResponse(401, {
          statusCode: 401,
          code: "FST_JWT_AUTHORIZATION_TOKEN_INVALID",
          error: "Unauthorized",
          message: "Authorization token is invalid: The token signature is invalid.",
        });
      }
      if (auth === `Bearer ${FRESH}`) {
        return jsonResponse(200, { ok: true, connections: [] });
      }
      return jsonResponse(500, { error: "unexpected auth header", got: auth ?? null });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await plutoApi<{ ok: boolean; connections: unknown[] }>("/dbio/connections");

    expect(out).toEqual({ ok: true, connections: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Stale token must be purged; fresh session token untouched.
    expect(localStorage.getItem(LS_TOKEN)).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toContain(FRESH);

    // Confirm the second call actually used the fresh bearer.
    const secondInit = (fetchMock.mock.calls[1] as unknown[])[1] as RequestInit;
    const secondAuth = (secondInit.headers as Record<string, string>)["Authorization"];
    expect(secondAuth).toBe(`Bearer ${FRESH}`);
  });

  it("does not retry when the failure is not a JWT-signature error", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, { code: "FORBIDDEN", message: "no access" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(plutoApi("/dbio/connections")).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Legacy token should NOT be purged on unrelated failures.
    expect(localStorage.getItem(LS_TOKEN)).toBe(STALE);
  });

  it("subsequent calls after self-heal go straight to the fresh session token", async () => {
    const fetchMock = vi
      .fn(async (): Promise<Response> => jsonResponse(200, { ok: true }))
      .mockImplementationOnce(async () =>
        jsonResponse(401, {
          code: "FST_JWT_AUTHORIZATION_TOKEN_INVALID",
          message: "invalid signature",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await plutoApi("/dbio/whoami"); // triggers heal
    await plutoApi("/dbio/jobs");   // should be single-shot, fresh token

    // 1st call: stale attempt + retry = 2, 2nd call: 1 → total 3
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const thirdInit = (fetchMock.mock.calls[2] as unknown[])[1] as RequestInit;
    const thirdAuth = (thirdInit.headers as Record<string, string>)["Authorization"];
    expect(thirdAuth).toBe(`Bearer ${FRESH}`);
  });

  it("uses the same-origin proxy base when no upstream URL is configured", async () => {
    localStorage.removeItem(LS_URL);
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await plutoApi("/dbio/whoami");

    const url = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(url).toBe("/api/pluto/dbio/whoami");
  });
});
