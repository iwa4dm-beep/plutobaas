// Same-origin orchestrated deploy endpoint.
//
// POST /api/pluto/deploy
//   Headers: authorization: Bearer <PLUTO_SERVICE_ROLE_KEY>
//   Body: { workspaceId, sql, bundlePath, contentBase64, bucket?, label?, maxRetries?, ensureInfra? }
//
// Wraps `deployAll` (ensureInfra → pushMigrations → uploadBundle → verifyDeploy)
// so external callers (curl, CI, browser UI) can trigger a full real deploy
// without individually hitting three RPCs. Returns detailed per-step + per-attempt
// logs so a failed step can be inspected and retried with the same bundle.
import { createFileRoute } from "@tanstack/react-router";
import { deployAll } from "@/lib/pluto/vps-deployer.functions";
import { isValidServiceToken } from "@/lib/pluto/vps-client";

export const Route = createFileRoute("/api/pluto/deploy")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const provided = auth.replace(/^Bearer\s+/i, "").trim();
        if (!(await isValidServiceToken(provided))) {
          return Response.json({ ok: false, error: "Unauthorized", hint: "Send Bearer <PLUTO_SERVICE_ROLE_KEY> or a service-role HS256 JWT signed with PLUTO_JWT_SECRET." }, { status: 401 });
        }

        let body: unknown;
        try { body = await request.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }); }

        try {
          const result = await deployAll({ data: body as never });
          return Response.json(result, { status: result.ok ? 200 : 502 });
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
        }
      },
    },
  },
});
