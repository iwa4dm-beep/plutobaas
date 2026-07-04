// Phase 59 — Data API v4 integration tests via Fastify inject.
import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { registerRpc, resetRpcRegistry } from "../lib/rpc-registry.js";
import { parseNdjson } from "../lib/stream-json.js";

const WS = "00000000-0000-0000-0000-000000000059";
let app: FastifyInstance;

beforeAll(async () => {
  process.env.PLUTO_ENABLE_DATA_API_V4 = "1";
  const { dataApiV4Plugin } = await import("../modules/data_api_v4/plugin.js");
  app = Fastify();
  await app.register(dataApiV4Plugin);
  await app.ready();

  registerRpc({
    workspace_id: WS,
    name: "sum",
    description: "Sum two numbers.",
    input: z.object({ a: z.number(), b: z.number() }),
    output: z.object({ total: z.number() }),
    handler: async ({ a, b }) => ({ total: a + b }),
  });
});

function h() {
  return { apikey: "t", "content-type": "application/json", "x-workspace-id": WS };
}

describe("data_api_v4 RPC HTTP", () => {
  it("invokes a typed RPC", async () => {
    const res = await app.inject({ method: "POST", url: "/rest/v4/rpc/sum", headers: h(), payload: JSON.stringify({ a: 4, b: 5 }) });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, data: { total: 9 } });
  });

  it("returns 400 on invalid input", async () => {
    const res = await app.inject({ method: "POST", url: "/rest/v4/rpc/sum", headers: h(), payload: JSON.stringify({ a: "x", b: 1 }) });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_input");
  });

  it("returns 404 for unknown RPC", async () => {
    const res = await app.inject({ method: "POST", url: "/rest/v4/rpc/nope", headers: h(), payload: "{}" });
    expect(res.statusCode).toBe(404);
  });

  it("serves OpenAPI 3.1 document containing the registered RPC", async () => {
    const res = await app.inject({ method: "GET", url: "/rest/v4/openapi", headers: h() });
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/rest/v4/rpc/sum"]).toBeDefined();
    expect(doc.paths["/rest/v4/rpc/ping"]).toBeDefined();
  });

  afterEachCleanup();
});

function afterEachCleanup() { /* keep registry between tests to build up state */ void resetRpcRegistry; }

describe("data_api_v4 cursor pagination", () => {
  it("iterates the full dataset in stable order without gaps or duplicates", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let iterations = 0;
    while (iterations++ < 100) {
      const url = `/rest/v4/query?limit=37${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await app.inject({ method: "GET", url, headers: h() });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { items: { id: string }[]; next_cursor: string | null; has_more: boolean };
      for (const it of body.items) seen.push(it.id);
      if (!body.has_more) break;
      cursor = body.next_cursor!;
    }
    expect(seen.length).toBe(250);
    expect(new Set(seen).size).toBe(250);
    const sorted = [...seen].sort();
    expect(seen).toEqual(sorted);
  });

  it("rejects a cursor from a different spec", async () => {
    const first = await app.inject({ method: "GET", url: "/rest/v4/query?limit=1&order_by=created_at&direction=asc", headers: h() });
    const c = JSON.parse(first.body).next_cursor as string;
    const res = await app.inject({ method: "GET", url: `/rest/v4/query?limit=1&order_by=created_at&direction=desc&cursor=${encodeURIComponent(c)}`, headers: h() });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/cursor_spec_mismatch/);
  });
});

describe("data_api_v4 streaming NDJSON", () => {
  it("emits meta, row frames, and a terminating end frame", async () => {
    const res = await app.inject({ method: "GET", url: "/rest/v4/stream?limit=20&chunk=5", headers: h() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const frames = parseNdjson(res.body);
    expect(frames[0].type).toBe("meta");
    const rows = frames.filter((f) => f.type === "row");
    expect(rows).toHaveLength(20);
    const end = frames[frames.length - 1];
    expect(end.type).toBe("end");
    if (end.type === "end") {
      expect(end.count).toBe(20);
      expect(end.next_cursor).toMatch(/^row_/);
    }
  });
});
