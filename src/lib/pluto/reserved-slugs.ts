// Shared slug validator + reserved list — mirrors migration 0034.
// Keep this in sync with admin.reserved_slugs on the server.

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www", "api", "app", "admin", "dashboard", "auth", "storage",
  "functions", "realtime", "cdn", "mail", "smtp", "status", "docs",
  "help", "support", "billing", "login", "signup", "preview",
  "sandbox", "static", "assets", "files",
  "lovable", "vercel", "supabase", "pluto",
]);

// DNS-label safe, 3–40 chars, starts+ends alphanumeric, single dashes only.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export type SlugCheck =
  | { ok: true }
  | { ok: false; reason: "too-short" | "too-long" | "format" | "reserved" };

export function checkSlug(raw: string): SlugCheck {
  const s = (raw ?? "").trim().toLowerCase();
  if (s.length < 3) return { ok: false, reason: "too-short" };
  if (s.length > 40) return { ok: false, reason: "too-long" };
  if (!SLUG_RE.test(s)) return { ok: false, reason: "format" };
  if (RESERVED_SLUGS.has(s)) return { ok: false, reason: "reserved" };
  return { ok: true };
}

export function slugReasonMessage(reason: Exclude<SlugCheck, { ok: true }>["reason"]): string {
  switch (reason) {
    case "too-short": return "কমপক্ষে ৩ অক্ষর লাগবে।";
    case "too-long":  return "সর্বোচ্চ ৪০ অক্ষর।";
    case "format":    return "শুধু ছোট হাতের অক্ষর, সংখ্যা ও ড্যাশ (-); শুরু/শেষে ড্যাশ নয়।";
    case "reserved":  return "এই slug সংরক্ষিত — অন্য একটি বেছে নিন।";
  }
}

/** Coerce arbitrary input into the closest-valid slug shape (used in onChange). */
export function coerceSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Build the preview subdomain URL for a slug. */
export function previewSubdomainUrl(
  slug: string,
  apex: string = (typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_PLUTO_APP_HOST) || "app.timescard.cloud",
): string {
  return `https://${slug}.${apex}`;
}
