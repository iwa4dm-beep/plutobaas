// POST /api/public/provision-subdomain
// Body: { slug, seed?: true, rotateSecret?: false, revealSecret?: false, baseDomain? }
// Auth: Bearer <service token> (isValidServiceToken).
// Returns worker /admin/provision response: subdomain, url, seeded, served, secretRef, ...
import { createFileRoute } from "@tanstack/react-router";
import { isValidServiceToken } from "@/lib/pluto/vps-client";
import { callProvisionSubdomain, ProvisionSchema } from "@/lib/pluto/slug-secrets.functions";

function headers() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "content-type": "application/json",
    "cache-control": "no-store",
  };
}

export const Route = createFileRoute("/api/public/provision-subdomain")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: headers() }),
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.replace(/^Bearer\s+/i, "").trim();
        if (!(await isValidServiceToken(token))) {
          return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: headers() });
        }
        let body: unknown;
        try { body = await request.json(); }
        catch { return new Response(JSON.stringify({ ok: false, error: "invalid_json_body" }), { status: 400, headers: headers() }); }
        const parsed = ProvisionSchema.safeParse(body);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ ok: false, error: "invalid_input", issues: parsed.error.issues }),
            { status: 400, headers: headers() }
          );
        }
        try {
          const result = await callProvisionSubdomain(parsed.data);
          const status = (result.ok === false) ? 502 : 200;
          return new Response(JSON.stringify(result, null, 2), { status, headers: headers() });
        } catch (e) {
          return new Response(
            JSON.stringify({ ok: false, error: (e as Error).message || "provision_failed" }),
            { status: 502, headers: headers() }
          );
        }
      },
    },
  },
});
