// Client-safe helpers: detect the format of a Pluto/Supabase API key.
//
// - JWT (eyJ...)          → works with fastify-jwt admin API
// - sk_secret_* / sk_svc_* → new Supabase secret-key format (PostgREST/Storage OK,
//                            rejected by fastify-jwt)
// - pk_* / anon-JWT        → publishable/anon
// - unknown                → cannot classify

export type KeyFormat =
  | { kind: "jwt"; role: "service_role" | "anon" | "authenticated" | "unknown"; header: unknown; payload: unknown }
  | { kind: "sk_secret" }
  | { kind: "sk_svc" }
  | { kind: "pk_publishable" }
  | { kind: "empty" }
  | { kind: "unknown" };

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  if (typeof atob === "function") return atob(b64);
  // Node fallback (SSR)
  return Buffer.from(b64, "base64").toString("binary");
}

export function detectKeyFormat(raw: string): KeyFormat {
  const key = (raw ?? "").trim();
  if (!key) return { kind: "empty" };

  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    try {
      const [h, p] = key.split(".");
      const header  = JSON.parse(b64urlDecode(h));
      const payload = JSON.parse(b64urlDecode(p));
      const role = (payload && typeof payload === "object" && "role" in payload && typeof (payload as { role?: unknown }).role === "string")
        ? (payload as { role: string }).role as "service_role" | "anon" | "authenticated"
        : "unknown";
      return { kind: "jwt", role, header, payload };
    } catch {
      return { kind: "jwt", role: "unknown", header: null, payload: null };
    }
  }

  if (/^sk_secret_/.test(key)) return { kind: "sk_secret" };
  if (/^sk_svc_/.test(key))    return { kind: "sk_svc" };
  if (/^pk_/.test(key))        return { kind: "pk_publishable" };

  return { kind: "unknown" };
}

export function isAdminCompatible(fmt: KeyFormat): boolean {
  return fmt.kind === "jwt" && (fmt.role === "service_role" || fmt.role === "unknown");
}

export function describeKey(fmt: KeyFormat): string {
  switch (fmt.kind) {
    case "empty":          return "no key configured";
    case "jwt":            return `JWT (role: ${fmt.role})`;
    case "sk_secret":      return "sk_secret_* — Supabase secret key (not JWT)";
    case "sk_svc":         return "sk_svc_* — Supabase service key (not JWT)";
    case "pk_publishable": return "pk_* — publishable key (anon-level)";
    case "unknown":        return "unknown format";
  }
}
