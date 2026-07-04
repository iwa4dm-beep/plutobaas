// Phase 61 integration tests — Vector v3 HTTP surface.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { _resetHnswForTests } from "../lib/hnsw-tuning.js";
import { parseNdjson } from "../lib/stream-json.js";

const WS = "00000000-0000-0000-0000-000000000061";
let app: FastifyInstance;

beforeAll(async () => {
  process.env.PLUTO_ENABLE_VECTOR_V3 = "1";
  const { vectorV3Plugin } = await import("../modules/vector_v3/plugin.js");
  app = Fastify();
  await app.register(vectorV3Plugin);
  await app.ready();
});

beforeEach(() => _resetHnswForTests());

const H = { "content-type": "application/json", "x-workspace-id": WS };
const post = (url: string, body: unknown) => app.inject({ method: "POST", url, headers: H, payload: JSON.stringify(body) });
const get = (url: string) => app.inject({ method: "GET", url, headers: H });

describe("vector v3 HNSW tuning HTTP", () => {
  it("sets, lists, and emits DDL for an index", async () => {
    const s = await post("/vec/v3/hnsw/config", { index_name: "docs_idx", m: 24, ef_construction: 300 });
    expect(s.statusCode).toBe(200);
    const list = JSON.parse((await get("/vec/v3/hnsw/config")).body);
    expect(list.configs).toHaveLength(1);
    expect(list.configs[0].m).toBe(24);
    const ddl = JSON.parse((await get("/vec/v3/hnsw/docs_idx/ddl?table=documents&column=embedding")).body);
    expect(ddl.ddl).toMatch(/create index/);
    expect(ddl.ddl).toMatch(/m = 24/);
  });

  it("rejects invalid parameters", async () => {
    const bad = await post("/vec/v3/hnsw/config", { index_name: "x", m: 1000 });
    expect(bad.statusCode).toBe(400);
  });
});

describe("vector v3 hybrid search HTTP", () => {
  it("linear rerank returns items in deterministic order with tie-breaking", async () => {
    const res = await post("/vec/v3/hybrid/search", {
      candidates: [
        { id: "a", vector_score: 0.9, lexical_score: 0.1 },
        { id: "b", vector_score: 0.2, lexical_score: 0.95 },
        { id: "c", vector_score: 0.6, lexical_score: 0.6 },
        { id: "d", vector_score: 0.6, lexical_score: 0.6 },
      ],
      strategy: "linear", alpha: 0.5,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const cIdx = body.results.findIndex((r: { id: string }) => r.id === "c");
    const dIdx = body.results.findIndex((r: { id: string }) => r.id === "d");
    expect(cIdx).toBeLessThan(dIdx); // id tiebreak: "c" < "d"
  });

  it("RRF fuses ranks without duplicate ids", async () => {
    const res = await post("/vec/v3/hybrid/search", {
      candidates: Array.from({ length: 20 }, (_, i) => ({
        id: `c${String(i).padStart(2, "0")}`,
        vector_score: Math.random(),
        lexical_score: Math.random(),
      })),
      strategy: "rrf", k: 60,
    });
    const body = JSON.parse(res.body);
    const ids = body.results.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("vector v3 streaming embeddings HTTP", () => {
  it("streams NDJSON with one row frame per input plus meta/end", async () => {
    const res = await post("/vec/v3/embeddings/stream", {
      inputs: ["hello", "world", "foo", "bar"],
      batch_size: 2,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    const frames = parseNdjson(res.body);
    expect(frames[0].type).toBe("meta");
    const rows = frames.filter((f) => f.type === "row");
    expect(rows).toHaveLength(4);
    const end = frames[frames.length - 1];
    expect(end.type).toBe("end");
  });

  it("rejects an empty inputs array", async () => {
    const res = await post("/vec/v3/embeddings/stream", { inputs: [] });
    expect(res.statusCode).toBe(400);
  });
});
