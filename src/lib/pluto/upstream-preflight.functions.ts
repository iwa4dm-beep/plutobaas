// Auto-Deploy preflight: probe the Pluto admin API with the resolved
// service-role token (stored JWT or auto-minted from PLUTO_JWT_SECRET)
// so the UI can warn about auth misconfiguration BEFORE any deploy runs.
//
// Returns a structured, human-readable result. Never throws.
import { createServerFn } from "@tanstack/react-start";
import { getVpsBaseUrl, getServiceRoleKey } from "./vps-client";

export type UpstreamPreflight = {
  ok: boolean;
  baseUrl: string;
  tokenSource: "operator-token" | "stored-jwt" | "minted-from-jwt-secret" | "stored-opaque" | "none";
  checks: Array<{
    label: string;
    url: string;
    status: number;
    ok: boolean;
    detail: string;
    latencyMs: number;
  }>;
  hint: string | null;
};


async function probe(url: string, headers: Record<string, string>, label: string, method: "GET" | "POST" = "GET") {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method, headers });
    const text = await r.text();
    return { label, url, status: r.status, ok: r.ok, detail: text.slice(0, 240), latencyMs: Date.now() - t0 };
  } catch (e) {
    return { label, url, status: 0, ok: false, detail: (e as Error).message, latencyMs: Date.now() - t0 };
  }
}

export const pingUpstream = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => {
    const v = (d && typeof d === "object" ? (d as { operatorToken?: unknown }).operatorToken : undefined);
    return { operatorToken: typeof v === "string" && v.length > 0 ? v : undefined };
  })
  .handler(async ({ data }): Promise<UpstreamPreflight> => {
  const base = getVpsBaseUrl();
  const storedRaw = (process.env.PLUTO_SERVICE_ROLE_KEY ?? "").trim();
  const jwtSecret = (process.env.PLUTO_JWT_SECRET ?? "").trim();
  const operatorToken = data.operatorToken?.trim();
  const token = operatorToken || (await getServiceRoleKey());
  const tokenSource: UpstreamPreflight["tokenSource"] = operatorToken
    ? "operator-token"
    : !token
      ? "none"
      : storedRaw && storedRaw.split(".").length === 3
        ? "stored-jwt"
        : jwtSecret
          ? "minted-from-jwt-secret"
          : "stored-opaque";

  const headers: Record<string, string> = { accept: "application/json" };
  if (token) { headers.apikey = token; headers.authorization = `Bearer ${token}`; }

  const c1 = await probe(`${base}/admin/v1/health`, { accept: "application/json" }, "admin health (public)");
  const c2 = await probe(`${base}/admin/v1/workspaces?limit=1`, headers, "admin workspaces (auth)");


  let hint: string | null = null;
  if (tokenSource === "none") {
    hint = "PLUTO_SERVICE_ROLE_KEY and PLUTO_JWT_SECRET are both missing. Add one of them so a service-role JWT can be resolved.";
  } else if (!c1.ok) {
    hint = `Upstream ${base} unreachable — check PLUTO_UPSTREAM_URL and that the Pluto API service is running.`;
  } else if (!c2.ok && c2.status === 401) {
    hint = tokenSource === "minted-from-jwt-secret"
      ? "Minted a JWT from PLUTO_JWT_SECRET but the upstream rejected the signature. PLUTO_JWT_SECRET does not match the value deployed on the Pluto VPS. Update it (or store a valid service_role JWT in PLUTO_SERVICE_ROLE_KEY) so deploys can authenticate."
      : "PLUTO_SERVICE_ROLE_KEY is present but rejected as invalid by the upstream. Store a valid HS256 JWT with role=\"service_role\", or set PLUTO_JWT_SECRET so one can be minted automatically.";
  } else if (!c2.ok) {
    hint = `Admin API returned HTTP ${c2.status} — see detail.`;
  }

  return { ok: c1.ok && c2.ok, baseUrl: base, tokenSource, checks: [c1, c2], hint };
});
