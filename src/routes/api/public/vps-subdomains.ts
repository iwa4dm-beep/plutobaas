import { createFileRoute } from "@tanstack/react-router";
import { fetchActiveSubdomains } from "@/lib/pluto/vps-health.functions";
import { isValidServiceToken } from "@/lib/pluto/vps-client";

function headers() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "content-type": "application/json",
    "cache-control": "no-store",
  };
}

export const Route = createFileRoute("/api/public/vps-subdomains")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: headers() }),
      GET: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.replace(/^Bearer\s+/i, "").trim();
        if (!(await isValidServiceToken(token))) {
          return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: headers() });
        }
        const url = new URL(request.url);
        const report = await fetchActiveSubdomains(url.searchParams.get("baseDomain") || undefined);
        return new Response(JSON.stringify(report, null, 2), { status: report.ok ? 200 : 502, headers: headers() });
      },
    },
  },
});