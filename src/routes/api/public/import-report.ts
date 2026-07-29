// Signed, expiring share link for an import job report.
//
//   GET /api/public/import-report?t=<token>[&format=json|html]
//
// SECURITY
//  - The token is HMAC-SHA256 signed with PLUTO_REPORT_SHARE_SECRET; the
//    signature is compared timing-safely and the embedded expiry is enforced.
//  - A token grants read access to exactly one job's report bundle, nothing
//    else. No PII beyond the admin actor emails already in the audit trail.
//  - Full migration SQL is only included when the creator opted in.
//  - Responses are never cached.
import { createFileRoute } from "@tanstack/react-router";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/import-report")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const token = url.searchParams.get("t") ?? "";
        const format = url.searchParams.get("format") === "html" ? "html" : "json";
        if (!token) return json({ error: "missing_token" }, 400);

        const { shareSecret, verifyShareToken } = await import("@/lib/pluto/report-share.server");
        const secret = shareSecret();
        if (!secret) return json({ error: "share_links_not_configured" }, 503);

        const verified = await verifyShareToken(token, secret);
        if (!verified.ok) {
          return json({ error: verified.error }, verified.error === "expired" ? 410 : 401);
        }

        const { buildReportBundle } = await import("@/lib/pluto/report-bundle.server");
        const bundle = await buildReportBundle(verified.payload.j, verified.payload.s === true, null, {
          expiresAt: new Date(verified.payload.e * 1000).toISOString(),
          createdBy: verified.payload.a ?? null,
        });
        if (!bundle) return json({ error: "not_found" }, 404);

        if (format === "html") {
          const { buildReportHtml } = await import("@/lib/pluto/import-report");
          return new Response(buildReportHtml(bundle), {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          });
        }
        return json(bundle);
      },
    },
  },
});
