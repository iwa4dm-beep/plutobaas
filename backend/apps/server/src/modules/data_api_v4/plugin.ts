// Phase 59 — Data API v4 plugin.
//
// Endpoints (all under /rest/v4, gated by PLUTO_ENABLE_DATA_API_V4=1):
//   POST /rest/v4/rpc/:name          — invoke typed RPC
//   GET  /rest/v4/rpc                — list RPCs for workspace
//   GET  /rest/v4/openapi            — OpenAPI 3.1 contract for RPCs
//   GET  /rest/v4/query              — cursor-paginated demo list
//   GET  /rest/v4/stream             — NDJSON streaming demo
//
// The plugin ships a small in-memory `demo_rows` fixture so integration
// tests can validate cursor stability and streaming semantics without a
// live database. Real deployments register RPCs via `registerRpc()`.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRpc, invokeRpc, listRpcs, registerRpc, emitOpenApi } from "../../lib/rpc-registry.js";
import { paginate, type CursorSpec } from "../../lib/cursor-pagination.js";
import { streamNdjson, chunked } from "../../lib/stream-json.js";

const enabled = process.env.PLUTO_ENABLE_DATA_API_V4 === "1";

// Deterministic in-memory fixture used by /query and /stream.
type Row = { id: string; created_at: string; title: string; workspace_id: string };
const demoRows: Row[] = [];
function seed(ws: string) {
  if (demoRows.some((r) => r.workspace_id === ws)) return;
  for (let i = 0; i < 250; i++) {
    demoRows.push({
      id: `row_${ws}_${String(i).padStart(4, "0")}`,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      title: `item ${i}`,
      workspace_id: ws,
    });
  }
}

// Ship one built-in RPC per workspace so /openapi always has content.
function ensureBuiltinRpc(ws: string) {
  if (getRpc(ws, "ping")) return;
  registerRpc({
    workspace_id: ws,
    name: "ping",
    description: "Health check RPC — echoes payload with server timestamp.",
    input: z.object({ msg: z.string().max(200).default("hi") }),
    output: z.object({ echo: z.string(), server_time: z.string() }),
    handler: async ({ msg }) => ({ echo: msg, server_time: new Date().toISOString() }),
  });
}

export async function dataApiV4Plugin(app: FastifyInstance) {
  if (!enabled) return;

  app.addHook("preHandler", async (req, reply) => {
    const ws = req.headers["x-workspace-id"] as string | undefined;
    if (!ws) { reply.code(400); return { error: "missing_workspace" }; }
    ensureBuiltinRpc(ws);
    seed(ws);
  });

  // --- RPC ----------------------------------------------------------------
  app.post("/rest/v4/rpc/:name", async (req, reply) => {
    const ws = req.headers["x-workspace-id"] as string;
    const name = (req.params as { name: string }).name;
    const result = await invokeRpc(ws, name, req.body ?? {});
    if (!result.ok) {
      reply.code(result.error === "rpc_not_found" ? 404 : 400);
      return result;
    }
    return result;
  });

  app.get("/rest/v4/rpc", async (req) => {
    const ws = req.headers["x-workspace-id"] as string;
    return {
      rpcs: listRpcs(ws).map((r) => ({ name: r.name, description: r.description })),
    };
  });

  app.get("/rest/v4/openapi", async (req) => {
    const ws = req.headers["x-workspace-id"] as string;
    return emitOpenApi(ws);
  });

  // --- Cursor pagination --------------------------------------------------
  app.get("/rest/v4/query", async (req, reply) => {
    const ws = req.headers["x-workspace-id"] as string;
    const q = z.object({
      order_by: z.enum(["created_at", "id"]).default("created_at"),
      direction: z.enum(["asc", "desc"]).default("asc"),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      cursor: z.string().optional(),
    }).safeParse(req.query);
    if (!q.success) { reply.code(400); return { error: "bad_request", issues: q.error.issues }; }

    const spec: CursorSpec = { order_by: q.data.order_by, direction: q.data.direction, id_column: "id" };
    const rows = demoRows.filter((r) => r.workspace_id === ws);
    try {
      return paginate(rows, spec, { limit: q.data.limit, cursor: q.data.cursor });
    } catch (e) {
      reply.code(400);
      return { error: (e as Error).message };
    }
  });

  // --- Streaming NDJSON ---------------------------------------------------
  app.get("/rest/v4/stream", async (req, reply) => {
    const ws = req.headers["x-workspace-id"] as string;
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(10_000).default(1000),
      chunk: z.coerce.number().int().min(1).max(1000).default(64),
    }).safeParse(req.query);
    if (!q.success) { reply.code(400); return { error: "bad_request" }; }
    const rows = demoRows.filter((r) => r.workspace_id === ws).slice(0, q.data.limit);
    await streamNdjson(reply, chunked(rows, q.data.chunk), {
      schema: "demo_rows",
      total: rows.length,
      extract_cursor: (last) => last.id,
    });
  });
}
