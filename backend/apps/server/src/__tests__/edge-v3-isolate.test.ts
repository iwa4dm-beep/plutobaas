// Contract tests for the edge-function isolate runtime.
//
// Exercises the real `invokeIsolate` (which spawns a worker_thread) with
// small snippets to prove the request/response contract and environment
// bindings (`req`, `ctx`) are wired end-to-end. Also verifies the sandbox
// hardening (no eval, no require, deadline enforcement).

import { describe, expect, it } from "vitest";
import { invokeIsolate } from "../modules/_archive/edge_v3/isolate.js";

const REQ = { method: "GET", url: "/x?name=world", headers: {}, body: undefined };
const OPTS = { timeoutMs: 3000, memoryMb: 64, allowHosts: [] as string[] };

describe("edge_v3 isolate runtime", () => {
  it("echoes ctx.workspace_id from a module.exports handler", async () => {
    const code = `
      module.exports = async ({ req, ctx }) => ({
        workspace_id: ctx.workspace_id,
        method: req.method,
      });
    `;
    const r = await invokeIsolate({ code, req: REQ, ctx: { workspace_id: "ws-1", user_id: "u-1" }, ...OPTS });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ workspace_id: "ws-1", method: "GET" });
  });

  it("captures console.log via structured log messages", async () => {
    const code = `module.exports = async () => { console.log("hi", "there"); return 1; };`;
    const r = await invokeIsolate({ code, req: REQ, ctx: {}, ...OPTS });
    expect(r.ok).toBe(true);
    expect(r.logs.some((l) => l.level === "info" && l.args.join(" ").includes("hi"))).toBe(true);
  });

  it("blocks fetch to a host not on the allow-list", async () => {
    const code = `
      module.exports = async () => {
        try { await fetch("https://evil.example.com/"); return "leaked"; }
        catch (e) { return "blocked:" + e.message; }
      };
    `;
    const r = await invokeIsolate({ code, req: REQ, ctx: {}, ...OPTS, allowHosts: ["api.github.com"] });
    expect(r.ok).toBe(true);
    expect(String(r.result)).toMatch(/^blocked:fetch_blocked:/);
  });

  it("rejects runtime eval / new Function (codeGeneration.strings=false)", async () => {
    const code = `
      module.exports = async () => {
        try { const f = new Function("return 41"); return f() + 1; }
        catch (e) { return "no-eval:" + e.message; }
      };
    `;
    const r = await invokeIsolate({ code, req: REQ, ctx: {}, ...OPTS });
    expect(r.ok).toBe(true);
    expect(String(r.result)).toMatch(/^no-eval:/);
  });

  it("does not expose Node globals (process/require/Buffer)", async () => {
    const code = `
      module.exports = async () => ({
        process: typeof process,
        require: typeof require,
        buffer: typeof Buffer,
      });
    `;
    const r = await invokeIsolate({ code, req: REQ, ctx: {}, ...OPTS });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ process: "undefined", require: "undefined", buffer: "undefined" });
  });

  it("enforces the wall-clock deadline on an infinite loop", async () => {
    const code = `module.exports = async () => { while (true) {} };`;
    const r = await invokeIsolate({ code, req: REQ, ctx: {}, ...OPTS, timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^(deadline_|exit_)/);
  }, 5000);

  it("reports a helpful error when no default export is present", async () => {
    const r = await invokeIsolate({ code: `const x = 1;`, req: REQ, ctx: {}, ...OPTS });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no_default_export/);
  });
});
