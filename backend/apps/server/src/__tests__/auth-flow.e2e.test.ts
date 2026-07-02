// End-to-end verification of the REAL /auth/v1 REST surface: sign-up,
// sign-in, refresh-token rotation (old token becomes invalid after use),
// sign-out (revokes all refresh tokens for the user), rate-limit
// lockout after N bad passwords.
//
// Skipped unless PLUTO_E2E_DATABASE_URL is set, mirroring rls-e2e.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

process.env.DATABASE_URL     ??= process.env.PLUTO_E2E_DATABASE_URL ?? "postgres://test/test";
process.env.JWT_SECRET       ??= "test-jwt-secret-please-ignore-32chars-min-xxxxxx";
process.env.ANON_KEY         ??= "anon-test-key";
process.env.SERVICE_ROLE_KEY ??= "service-test-key";
process.env.ACCESS_TOKEN_TTL_SEC  ??= "2";     // short TTL so we can observe expiry
process.env.REFRESH_TOKEN_TTL_SEC ??= "60";

const url = process.env.PLUTO_E2E_DATABASE_URL;
const d = url ? describe : describe.skip;

let app: FastifyInstance;
const email = `e2e_${Date.now()}_${Math.random().toString(36).slice(2,8)}@test.local`;
const password = "correct-horse-battery-staple";
const anon = () => ({ apikey: process.env.ANON_KEY! });

async function inj(method: "POST" | "GET", url: string, headers: Record<string,string>, payload?: unknown) {
  const r = await app.inject({ method, url, headers, payload: payload as never });
  return { code: r.statusCode, body: r.json() as any };
}

d("auth E2E — sign-up, refresh rotation, sign-out", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url!;
    const { authRoutes } = await import("../modules/auth/routes.js");
    app = Fastify({ logger: false });
    await app.register(authRoutes, { prefix: "/auth/v1" });
    await app.ready();
  });
  afterAll(async () => { await app?.close(); });

  it("sign-up issues a session", async () => {
    const r = await inj("POST", "/auth/v1/sign-up", anon(), { email, password });
    expect(r.code).toBe(200);
    expect(r.body.session.access_token).toBeTruthy();
    expect(r.body.session.refresh_token).toBeTruthy();
  });

  it("refresh rotates: old refresh token becomes invalid after use", async () => {
    // sign-in fresh so we own a known refresh token
    const s = await inj("POST", "/auth/v1/sign-in", anon(), { email, password });
    expect(s.code).toBe(200);
    const rt1 = s.body.session.refresh_token as string;

    // 1st refresh: rotates, returns a new token
    const r1 = await inj("POST", "/auth/v1/refresh", anon(), { refresh_token: rt1 });
    expect(r1.code).toBe(200);
    const rt2 = r1.body.session.refresh_token as string;
    expect(rt2).not.toBe(rt1);

    // Reusing the ORIGINAL token now fails — proves rotation revoked it.
    const replay = await inj("POST", "/auth/v1/refresh", anon(), { refresh_token: rt1 });
    expect(replay.code).toBe(401);
    expect(replay.body.error).toBe("invalid_refresh_token");

    // The freshly minted token still works.
    const r3 = await inj("POST", "/auth/v1/refresh", anon(), { refresh_token: rt2 });
    expect(r3.code).toBe(200);
  });

  it("access token expires per ACCESS_TOKEN_TTL_SEC", async () => {
    const s = await inj("POST", "/auth/v1/sign-in", anon(), { email, password });
    const at = s.body.session.access_token as string;
    const exp = s.body.session.expires_at as number;
    expect(exp - Math.floor(Date.now()/1000)).toBeLessThanOrEqual(3);
    // GET /user with an expired bearer → 401 invalid_token from requireApiKey.
    await new Promise((r) => setTimeout(r, 2500));
    const me = await inj("GET", "/auth/v1/user", { ...anon(), authorization: `Bearer ${at}` });
    expect(me.code).toBe(401);
  });

  it("sign-out revokes all refresh tokens for the user", async () => {
    const s = await inj("POST", "/auth/v1/sign-in", anon(), { email, password });
    const at = s.body.session.access_token as string;
    const rt = s.body.session.refresh_token as string;

    const out = await inj("POST", "/auth/v1/sign-out", { ...anon(), authorization: `Bearer ${at}` });
    expect(out.code).toBe(200);

    const after = await inj("POST", "/auth/v1/refresh", anon(), { refresh_token: rt });
    expect(after.code).toBe(401);
  });

  it("brute-force lockout kicks in after repeated bad passwords", async () => {
    // 8 bad attempts triggers the per-account lockout (ACCT_LIMIT).
    let lastCode = 0;
    for (let i = 0; i < 10; i++) {
      const r = await inj("POST", "/auth/v1/sign-in", anon(), { email, password: "wrong-" + i });
      lastCode = r.code;
      if (lastCode === 429) break;
    }
    expect(lastCode).toBe(429);
    // Correct password is ALSO rejected while locked out.
    const locked = await inj("POST", "/auth/v1/sign-in", anon(), { email, password });
    expect(locked.code).toBe(429);
  });
});
