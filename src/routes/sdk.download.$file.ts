import { createFileRoute } from "@tanstack/react-router";

/**
 * Serves SDK tarballs from /public/downloads with strong caching headers.
 *
 *   /sdk/download/pluto-js-latest.tgz       -> short cache, ETag revalidated
 *   /sdk/download/pluto-js-0.1.0.tgz        -> immutable, 1 year
 *   /sdk/download/manifest.json             -> short cache
 *
 * ETag is derived from a SHA-256 of the response body, so npm/pnpm/bun can
 * revalidate cheaply with `If-None-Match` and get a 304 when unchanged.
 */
export const Route = createFileRoute("/sdk/download/$file")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const file = params.file;
        if (!/^[a-zA-Z0-9._-]+\.(tgz|json)$/.test(file)) {
          return new Response("Bad filename", { status: 400 });
        }

        // Pull the underlying static asset from the same origin (public/downloads/*).
        const upstream = new URL(`/downloads/${file}`, request.url);
        const res = await fetch(upstream);
        if (!res.ok) {
          return new Response("Not found", { status: res.status });
        }

        const buf = await res.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", buf);
        const etag =
          'W/"' +
          Array.from(new Uint8Array(digest).slice(0, 12))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("") +
          '"';

        // 304 short-circuit
        const inm = request.headers.get("if-none-match");
        if (inm && inm === etag) {
          return new Response(null, {
            status: 304,
            headers: { ETag: etag, "Cache-Control": cacheControlFor(file) },
          });
        }

        const isTar = file.endsWith(".tgz");
        return new Response(buf, {
          status: 200,
          headers: {
            "Content-Type": isTar ? "application/gzip" : "application/json",
            "Content-Length": String(buf.byteLength),
            "Cache-Control": cacheControlFor(file),
            ETag: etag,
            "Access-Control-Allow-Origin": "*",
            ...(isTar
              ? { "Content-Disposition": `attachment; filename="${file}"` }
              : {}),
          },
        });
      },
    },
  },
});

function cacheControlFor(file: string): string {
  // Versioned artifacts (e.g. pluto-js-0.1.0.tgz) are immutable — cache 1 year.
  // "latest" or manifest.json changes on each release — short cache + revalidate.
  if (/-\d+\.\d+\.\d+\.tgz$/.test(file)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=300, must-revalidate";
}
