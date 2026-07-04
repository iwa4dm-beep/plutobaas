// Sample edge function for the hardened isolate runtime.
//
// The runtime evaluates this as a classic script (vm.Script) with
// `module.exports = ...` — ESM `export default` is not available inside
// the sandbox because the isolate disables code generation from strings.
// Deploy by POSTing the file contents to /fn/v3/deployments as `code`.
//
// The isolate exposes: fetch, Response, Request, Headers, URL,
// URLSearchParams, TextEncoder/Decoder, crypto, atob, btoa,
// setTimeout (capped at 5s), console.{log,warn,error}, JSON, Math, Date.
// No process, require, Buffer, or fs.

module.exports = async function handler({ req, ctx }) {
  const url = new URL(req.url, "http://edge.local");
  const name = url.searchParams.get("name") || "world";

  // Environment bindings arrive on `ctx`:
  //   ctx.workspace_id — string | null
  //   ctx.user_id      — string | null (from api key / bearer)
  console.log("invoked by", ctx.user_id || "anonymous", "in ws", ctx.workspace_id);

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      hello: name,
      method: req.method,
      workspace_id: ctx.workspace_id || null,
      random: crypto.randomUUID(),
      now: new Date().toISOString(),
    },
  };
};
