// Verify that the current BOOTSTRAP_VERSION is live on the upstream VPS.
//
//   POST/GET /api/pluto/verify-bootstrap
//     Headers: authorization: Bearer <PLUTO_SERVICE_ROLE_KEY | service-role JWT>
//
// Returns { ok, expectedVersion, liveVersion, match, invoke, checkedAt, hint }.
// Use before re-running curl smoke tests to confirm the newly-deployed
// bootstrap function is the one actually being served.
import { createFileRoute } from "@tanstack/react-router";
import { verifyBootstrap } from "@/lib/pluto/vps-deployer.functions";
import { isValidServiceToken } from "@/lib/pluto/vps-client";

async function handle(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim();
  if (!(await isValidServiceToken(provided))) {
    return Response.json(
      { ok: false, error: "Unauthorized", hint: "Send Bearer <PLUTO_SERVICE_ROLE_KEY> or a service-role HS256 JWT signed with PLUTO_JWT_SECRET." },
      { status: 401 },
    );
  }
  const result = await verifyBootstrap();
  return Response.json(result, { status: result.ok ? 200 : 502 });
}

export const Route = createFileRoute("/api/pluto/verify-bootstrap")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
