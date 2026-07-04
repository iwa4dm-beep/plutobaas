// Phase 49 — Image transform cache keying + CDN URL helpers.
//
// A stable cache key is derived from (bucket, object_key, canonicalized
// transform variant). The variant is normalized so semantically identical
// requests (e.g. `?w=200&h=100` vs `?h=100&w=200`) share one cache entry
// and one CDN edge object.

import { createHash } from "node:crypto";

export type ImageVariant = {
  w?: number;
  h?: number;
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
  quality?: number;                          // 1-100
  format?: "auto" | "webp" | "avif" | "jpeg" | "png";
};

const ALLOWED_FIT = new Set(["cover","contain","fill","inside","outside"]);
const ALLOWED_FMT = new Set(["auto","webp","avif","jpeg","png"]);

export function normalizeVariant(v: ImageVariant): ImageVariant {
  const out: ImageVariant = {};
  if (typeof v.w === "number" && v.w > 0 && v.w <= 8192) out.w = Math.floor(v.w);
  if (typeof v.h === "number" && v.h > 0 && v.h <= 8192) out.h = Math.floor(v.h);
  if (v.fit && ALLOWED_FIT.has(v.fit)) out.fit = v.fit;
  if (typeof v.quality === "number" && v.quality >= 1 && v.quality <= 100) out.quality = Math.floor(v.quality);
  if (v.format && ALLOWED_FMT.has(v.format)) out.format = v.format;
  return out;
}

export function variantCanonical(v: ImageVariant): string {
  const n = normalizeVariant(v);
  return Object.keys(n).sort().map((k) => `${k}=${(n as Record<string, unknown>)[k]}`).join("&");
}

export function transformCacheKey(bucket: string, objectKey: string, v: ImageVariant): string {
  const h = createHash("sha256").update(`${bucket}|${objectKey}|${variantCanonical(v)}`).digest("hex");
  return `st3v:${h}`;
}

// Build a CDN URL under the configured PLUTO_CDN_BASE_URL. Kept deterministic
// so the URL itself doubles as the cache key at the edge.
export function cdnUrlFor(bucket: string, objectKey: string, v: ImageVariant): string {
  const base = (process.env.PLUTO_CDN_BASE_URL ?? "").replace(/\/+$/, "");
  const params = variantCanonical(v);
  const path = `/render/${encodeURIComponent(bucket)}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  return `${base}${path}${params ? "?" + params : ""}`;
}
