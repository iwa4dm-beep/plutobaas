// Phase 49 — unit tests for signed uploads, image cache keying, lifecycle eval.

import { describe, it, expect } from "vitest";
import { mintUploadToken, verifyUploadToken } from "../lib/signed-upload.js";
import { normalizeVariant, variantCanonical, transformCacheKey, cdnUrlFor } from "../lib/image-cache.js";
import { evaluateRule, matchesRule, type LifecycleRule } from "../lib/lifecycle.js";

describe("signed upload tokens", () => {
  it("round-trips a valid grant", () => {
    const t = mintUploadToken({ bucket: "b", object_key: "k", content_type: null, max_bytes: 1024, expires_at: Date.now() + 60_000 });
    const g = verifyUploadToken(t);
    expect(g?.bucket).toBe("b"); expect(g?.max_bytes).toBe(1024);
  });
  it("rejects tampered signature", () => {
    const t = mintUploadToken({ bucket: "b", object_key: "k", content_type: null, max_bytes: 10, expires_at: Date.now() + 60_000 });
    const [body] = t.split(".");
    expect(verifyUploadToken(`${body}.deadbeef`)).toBeNull();
  });
  it("rejects expired tokens", () => {
    const t = mintUploadToken({ bucket: "b", object_key: "k", content_type: null, max_bytes: 10, expires_at: Date.now() - 1 });
    expect(verifyUploadToken(t)).toBeNull();
  });
});

describe("image transform cache keying", () => {
  it("normalizes and drops invalid fields", () => {
    const v = normalizeVariant({ w: 200, h: 0, fit: "cover", quality: 999, format: "webp" });
    expect(v).toEqual({ w: 200, fit: "cover", format: "webp" });
  });
  it("canonical form is order-independent", () => {
    expect(variantCanonical({ h: 100, w: 200 })).toBe(variantCanonical({ w: 200, h: 100 }));
  });
  it("same variant → same cache key; different → different", () => {
    const a = transformCacheKey("b", "k.png", { w: 200 });
    const b = transformCacheKey("b", "k.png", { w: 200 });
    const c = transformCacheKey("b", "k.png", { w: 201 });
    expect(a).toBe(b); expect(a).not.toBe(c);
  });
  it("builds a CDN URL under the configured base", () => {
    process.env.PLUTO_CDN_BASE_URL = "https://cdn.example.com";
    const u = cdnUrlFor("bkt", "path/to/img.jpg", { w: 100, format: "webp" });
    expect(u.startsWith("https://cdn.example.com/render/bkt/")).toBe(true);
    expect(u).toContain("format=webp");
    expect(u).toContain("w=100");
  });
});

describe("lifecycle rule evaluation", () => {
  const now = Date.parse("2026-07-04T00:00:00Z");
  const rule: LifecycleRule = {
    id: "r", bucket: "logs", prefix: "app/", action: "expire", after_days: 7, enabled: true,
  };
  it("matches only objects older than after_days under prefix", () => {
    const objs = [
      { bucket: "logs", key: "app/a.log", created_at: now - 8 * 86_400_000 },
      { bucket: "logs", key: "app/b.log", created_at: now - 3 * 86_400_000 },
      { bucket: "logs", key: "other/c.log", created_at: now - 30 * 86_400_000 },
      { bucket: "other", key: "app/d.log", created_at: now - 30 * 86_400_000 },
    ];
    const { count, matched } = evaluateRule(objs, rule, now);
    expect(count).toBe(1); expect(matched[0].key).toBe("app/a.log");
  });
  it("respects disabled flag", () => {
    expect(matchesRule({ bucket: "logs", key: "app/x", created_at: 0 }, { ...rule, enabled: false }, now)).toBe(false);
  });
  it("skips tier action when target tier already applied", () => {
    const r = { ...rule, action: "tier" as const, target_tier: "archive", after_days: 1 };
    const obj = { bucket: "logs", key: "app/x", created_at: now - 30 * 86_400_000, storage_tier: "archive" };
    expect(matchesRule(obj, r, now)).toBe(false);
  });
});
