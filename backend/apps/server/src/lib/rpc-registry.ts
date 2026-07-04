// Phase 59 — Data API v4 RPC registry.
//
// Typed RPC-style functions with Zod-derived input/output schemas, an
// OpenAPI-compatible contract emitter, and pluggable handlers. Functions
// are workspace-scoped so a tenant cannot invoke another tenant's RPC.

import { z, ZodTypeAny } from "zod";

export type RpcDef<I extends ZodTypeAny = ZodTypeAny, O extends ZodTypeAny = ZodTypeAny> = {
  workspace_id: string;
  name: string;
  description?: string;
  input: I;
  output: O;
  handler: (input: z.infer<I>, ctx: { workspace_id: string; user_id?: string }) => Promise<z.infer<O>>;
};

const registry = new Map<string, RpcDef>();
const key = (ws: string, name: string) => `${ws}::${name}`;

export function registerRpc<I extends ZodTypeAny, O extends ZodTypeAny>(def: RpcDef<I, O>) {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(def.name)) throw new Error("bad_rpc_name");
  registry.set(key(def.workspace_id, def.name), def as unknown as RpcDef);
  return def;
}

export function getRpc(ws: string, name: string): RpcDef | undefined {
  return registry.get(key(ws, name));
}

export function listRpcs(ws: string): RpcDef[] {
  return Array.from(registry.values()).filter((r) => r.workspace_id === ws);
}

export function unregisterRpc(ws: string, name: string) {
  return registry.delete(key(ws, name));
}

export function resetRpcRegistry() { registry.clear(); }

export async function invokeRpc(ws: string, name: string, raw: unknown, ctx: { user_id?: string } = {}) {
  const def = registry.get(key(ws, name));
  if (!def) return { ok: false as const, error: "rpc_not_found" };
  const parsed = def.input.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: "invalid_input", issues: parsed.error.issues };
  const out = await def.handler(parsed.data, { workspace_id: ws, user_id: ctx.user_id });
  const validated = def.output.safeParse(out);
  if (!validated.success) return { ok: false as const, error: "invalid_output", issues: validated.error.issues };
  return { ok: true as const, data: validated.data };
}

// -------- OpenAPI contract emitter ----------------------------------------

function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  const t = def.typeName;
  if (t === "ZodString") return { type: "string" };
  if (t === "ZodNumber") return { type: "number" };
  if (t === "ZodBoolean") return { type: "boolean" };
  if (t === "ZodNull") return { type: "null" };
  if (t === "ZodAny" || t === "ZodUnknown") return {};
  if (t === "ZodLiteral") return { const: (def as unknown as { value: unknown }).value };
  if (t === "ZodArray") {
    const inner = (def as unknown as { type: ZodTypeAny }).type;
    return { type: "array", items: zodToJsonSchema(inner) };
  }
  if (t === "ZodOptional" || t === "ZodNullable" || t === "ZodDefault") {
    const inner = (def as unknown as { innerType: ZodTypeAny }).innerType;
    const base = zodToJsonSchema(inner);
    if (t === "ZodNullable") return { anyOf: [base, { type: "null" }] };
    return base;
  }
  if (t === "ZodObject") {
    const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = zodToJsonSchema(v);
      const tn = (v as unknown as { _def: { typeName: string } })._def.typeName;
      if (tn !== "ZodOptional" && tn !== "ZodDefault") required.push(k);
    }
    return { type: "object", properties, ...(required.length ? { required } : {}) };
  }
  if (t === "ZodEnum") {
    const values = (def as unknown as { values: string[] }).values;
    return { type: "string", enum: values };
  }
  if (t === "ZodRecord") return { type: "object", additionalProperties: {} };
  return {};
}

export function emitOpenApi(ws: string, base = "/rest/v4"): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const def of listRpcs(ws)) {
    paths[`${base}/rpc/${def.name}`] = {
      post: {
        summary: def.description ?? def.name,
        tags: ["rpc"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: zodToJsonSchema(def.input) } },
        },
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": {
              schema: { type: "object", properties: { ok: { const: true }, data: zodToJsonSchema(def.output) } },
            } },
          },
          "400": { description: "invalid_input" },
          "404": { description: "rpc_not_found" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Pluto Data API v4 — RPC", version: "1.0.0" },
    paths,
  };
}

export { zodToJsonSchema };
