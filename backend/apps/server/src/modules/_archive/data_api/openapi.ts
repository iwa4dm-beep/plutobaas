// OpenAPI 3.1 generator for the auto-REST surface.
import { getSchemaSnapshot, columnToOpenApi } from "./introspect.js";

export async function buildOpenApiDoc(baseUrl: string): Promise<Record<string, unknown>> {
  const snap = await getSchemaSnapshot();
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};
  for (const t of snap.tables) {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const c of t.columns) {
      props[c.name] = columnToOpenApi(c);
      if (!c.is_nullable && !c.is_pk) required.push(c.name);
    }
    schemas[t.name] = { type: "object", properties: props, required };
    const ref = { $ref: `#/components/schemas/${t.name}` };
    paths[`/${t.name}`] = {
      get: {
        summary: `List rows from ${t.name}`,
        parameters: [
          { name: "select", in: "query", schema: { type: "string" } },
          { name: "order",  in: "query", schema: { type: "string" } },
          { name: "limit",  in: "query", schema: { type: "integer", maximum: 1000 } },
          { name: "offset", in: "query", schema: { type: "integer" } },
        ],
        responses: { "200": { description: "OK",
          content: { "application/json": { schema: { type: "array", items: ref } } } } },
      },
      post: { summary: `Insert row(s) into ${t.name}`,
              requestBody: { content: { "application/json": { schema: {
                oneOf: [ref, { type: "array", items: ref }] } } } },
              responses: { "201": { description: "Created" } } },
      patch: { summary: `Update rows in ${t.name}`,
               requestBody: { content: { "application/json": { schema: ref } } },
               responses: { "200": { description: "OK" } } },
      delete: { summary: `Delete rows from ${t.name}`,
                responses: { "200": { description: "OK" } } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Pluto Data API", version: "1.0.0",
            description: "Auto-generated REST + GraphQL from the public schema." },
    servers: [{ url: baseUrl }],
    paths,
    components: { schemas,
      securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "apikey" } } },
    security: [{ apiKey: [] }],
  };
}
