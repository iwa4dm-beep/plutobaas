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
]);

async function handle({ request, params }: { request: Request; params: { _splat?: string } }) {
  const upstream = process.env.PLUTO_UPSTREAM_URL ?? "https://api.timescard.cloud";
  const splat = params._splat ?? "";
  const url = new URL(request.url);

  if (!upstream) {
    const issues = validateSecrets();
    // Graceful offline stub — probes see a well-formed 200 with offline:true
    // instead of a network error, and TerminalCard renders "backend not
    // configured" rather than the misleading "Failed to fetch".
    return new Response(
      JSON.stringify({
        ok: false,
        offline: true,
        path: `/${splat}`,
        reason: "PLUTO_UPSTREAM_URL not set — configure the Fastify backend URL in project secrets to enable live probes.",
        issues,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-pluto-offline": "1",
        },
      },
    );
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
    const respHeaders = new Headers();
    upstreamRes.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase())) respHeaders.set(key, value);
    });
    if (upstreamRes.ok) {
      recordSuccess(`/${splat}`);
    } else {
      recordError(`/${splat}`, `upstream returned ${upstreamRes.status}`);
    }
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordError(`/${splat}`, msg);
    return new Response(
      JSON.stringify({
        ok: false,
        offline: true,
        error: msg,
        target,
      }),
      { status: 200, headers: { "content-type": "application/json", "x-pluto-offline": "1" } },
    );
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
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, authorization, apikey",
            "access-control-max-age": "86400",
          },
        }),
    },
  },
});
