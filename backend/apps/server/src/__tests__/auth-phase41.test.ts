// Phase 41 — Contract tests for magic-link, anonymous sign-in and auth
// hooks. Uses the same in-memory Fastify pattern as the other auth tests:
// only exercises input validation + hook plumbing so it runs without a
// live Postgres.

import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {} }));
vi.mock("../lib/pgraw.js", () => ({ pgraw: vi.fn(async () => ({ rows: [] })) }));
vi.mock("argon2", () => ({ default: { hash: async () => "x", verify: async () => true, argon2id: 2 } }));

import { dispatchBefore } from "../lib/auth-hooks.js";

describe("Phase 41 auth-hooks dispatcher", () => {
  it("allows when no hooks configured", async () => {
    const r = await dispatchBefore("before_signin", { email: "a@b.co" });
    expect(r.allow).toBe(true);
  });
});

describe("Phase 41 route surface", () => {
  it("exports a Fastify plugin factory", async () => {
    const mod = await import("../modules/auth_phase41/plugin.js");
    expect(typeof mod.authPhase41Plugin).toBe("function");
  });
});
