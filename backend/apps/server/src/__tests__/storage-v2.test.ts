// Phase 42 — unit tests for the storage helpers that don't need a live DB.

import { describe, it, expect, vi } from "vitest";

describe("imgproxy signer", () => {
  it("returns null when not configured", async () => {
    delete process.env.PLUTO_IMGPROXY_URL;
    const { signImgproxyUrl } = await import("../lib/imgproxy.js");
    expect(signImgproxyUrl("https://x/y.jpg", { width: 100 })).toBeNull();
  });

  it("builds a signed URL when env is set", async () => {
    process.env.PLUTO_IMGPROXY_URL = "https://imgp.local";
    process.env.PLUTO_IMGPROXY_KEY = "aa".repeat(16);
    process.env.PLUTO_IMGPROXY_SALT = "bb".repeat(16);
    vi.resetModules();
    const { signImgproxyUrl } = await import("../lib/imgproxy.js");
    const url = signImgproxyUrl("https://cdn.local/bucket/photo.jpg", { width: 320, resize: "cover", format: "webp", quality: 80 });
    expect(url).toMatch(/^https:\/\/imgp\.local\/[A-Za-z0-9_-]+\/rs:fill:320:0:0\/q:80\/[A-Za-z0-9_-]+\.webp$/);
  });
});

describe("clamav client", () => {
  it("returns skipped when host env is unset", async () => {
    delete process.env.PLUTO_CLAMAV_HOST;
    vi.resetModules();
    const { scanBytes } = await import("../lib/clamav.js");
    const r = await scanBytes(new Uint8Array([1, 2, 3]));
    expect(r.verdict).toBe("skipped");
  });
});

describe("storage_v2 plugin exports", () => {
  it("is a Fastify plugin factory", async () => {
    vi.doMock("../lib/pgraw.js", () => ({ pgraw: vi.fn(async () => ({ rows: [] })) }));
    vi.doMock("../lib/storage.js", () => ({ storage: { put: vi.fn(), get: vi.fn(), remove: vi.fn() } }));
    vi.doMock("../db/index.js", () => ({ db: {} }));
    vi.doMock("../lib/apikey.js", () => ({ requireApiKey: async () => {} }));
    vi.doMock("../lib/logs.js", () => ({ log: async () => {} }));
    const mod = await import("../modules/_archive/storage_v2/plugin.js");
    expect(typeof mod.storageV2Plugin).toBe("function");
  });
});
