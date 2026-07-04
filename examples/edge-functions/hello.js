// Sample edge function — Deno/V8-flavored ESM default export.
//
// Deployed via:
//   POST /fn/v3/deployments
//   { "slug": "hello", "code": "<contents of this file>",
//     "allow_hosts": ["api.github.com"] }
//
// The isolate runtime exposes: fetch, Response, Request, Headers,
// URL, URLSearchParams, TextEncoder/Decoder, crypto, atob, btoa,
// setTimeout (capped at 5s), console.{log,warn,error}, JSON, Math, Date.
// No process/require/Buffer/fs.

export default async function handler({ req, ctx }) {
  const url = new URL(req.url, "http://edge.local");
  const name = url.searchParams.get("name") ?? "world";

  // Environment bindings arrive on `ctx`:
  //   ctx.workspace_id — string | null
  //   ctx.user_id      — string | null (from api key / bearer)
  console.log("invoked by", ctx.user_id ?? "anonymous", "in ws", ctx.workspace_id);

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      hello: name,
      method: req.method,
      workspace_id: ctx.workspace_id ?? null,
      random: crypto.randomUUID(),
      now: new Date().toISOString(),
    },
  };
}
