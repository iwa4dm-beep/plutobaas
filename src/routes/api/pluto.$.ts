// Same-origin proxy to the Pluto/Fastify backend.
//
// Frontend calls `/api/pluto/<anything>` and this route either forwards to
// `PLUTO_UPSTREAM_URL` (production/self-host) or returns a graceful 503 JSON
// stub when the backend isn't configured (dev). Eliminates the
// `localhost:3000` "Failed to fetch" errors on fresh installs.
import { createFileRoute } from "@tanstack/react-router";
import { recordError, recordSuccess, validateSecrets } from "@/lib/pluto/upstream-status";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
  "content-encoding",
]);

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey, x-requested-with, accept, origin",
  "access-control-expose-headers": "content-type, x-pluto-offline, x-request-id",
  "access-control-max-age": "86400",
};

const GATEWAY_FAILURE_STATUSES = new Set([500, 502, 503, 504, 521, 522, 523, 524]);

function offlineJson(payload: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: false, offline: true, ...payload }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-pluto-offline": "1",
      ...CORS_HEADERS,
    },
  });
}

async function handle({ request, params }: { request: Request; params: { _splat?: string } }) {
  const upstream = process.env.PLUTO_UPSTREAM_URL ?? "https://api.timescard.cloud";
  const splat = params._splat ?? "";
  const url = new URL(request.url);

  if (!upstream) {
    const issues = validateSecrets();
    // Graceful offline stub — probes see a well-formed 200 with offline:true
    // instead of a network error, and TerminalCard renders "backend not
    // configured" rather than the misleading "Failed to fetch".
    return offlineJson({
      path: `/${splat}`,
      reason: "PLUTO_UPSTREAM_URL not set — configure the Fastify backend URL in project secrets to enable live probes.",
      issues,
    });
  }

  const target = upstream.replace(/\/$/, "") + "/" + splat + (url.search || "");
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  try {
    const upstreamRes = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: "manual",
    });
    const upstreamCT = (upstreamRes.headers.get("content-type") ?? "").toLowerCase();
    const looksLikeGatewayHtml = GATEWAY_FAILURE_STATUSES.has(upstreamRes.status)
      && !upstreamCT.includes("application/json")
      && !upstreamCT.includes("text/plain");
    if (looksLikeGatewayHtml) {
      // True gateway failure (nginx/Cloudflare error page, no JSON body).
      recordError(`/${splat}`, `upstream gateway failure ${upstreamRes.status}`);
      return offlineJson({
        path: `/${splat}`,
        target,
        upstreamStatus: upstreamRes.status,
        upstreamStatusText: upstreamRes.statusText,
        reason: "The Pluto backend origin is unreachable or unhealthy.",
      });
    }
    const respHeaders = new Headers();
    upstreamRes.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) respHeaders.set(key, value);
    });
    // Same-origin proxy — attach CORS defensively so callers on any subdomain work too.
    for (const [k, v] of Object.entries(CORS_HEADERS)) respHeaders.set(k, v);
    if (upstreamRes.ok) {
      recordSuccess(`/${splat}`);
    } else {
      recordError(`/${splat}`, `upstream returned ${upstreamRes.status}`);
    }
    // Pass through the real upstream body (including 4xx/5xx JSON errors) so
    // the UI can show the actual validation / auth message instead of a
    // generic "backend unreachable" stub.
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordError(`/${splat}`, msg);
    return offlineJson({ error: msg, target });
  }
}



export const Route = createFileRoute("/api/pluto/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
      HEAD: handle,
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: CORS_HEADERS,
        }),
    },
  },
});
