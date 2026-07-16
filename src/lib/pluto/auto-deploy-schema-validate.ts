// Minimal JSON-Schema (draft-07 subset) validator for Auto-Deploy webhook
// payloads. We keep this in-repo (no ajv dep) because the schemas in
// `auto-deploy-webhook-schemas.ts` use a small, well-known feature set:
//   type, required, properties, additionalProperties, const, enum,
//   minimum, format ("date-time" | "uri"), items (object).
//
// Returns a list of human-readable errors; empty array means "valid".

export type SchemaError = { path: string; message: string };

type JSchema = Record<string, unknown>;

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function matchesType(expected: string, v: unknown): boolean {
  const t = typeOf(v);
  if (expected === "number") return t === "integer" || t === "number";
  return t === expected;
}

function validateNode(
  schema: JSchema,
  value: unknown,
  path: string,
  errs: SchemaError[],
): void {
  const type = schema.type as string | undefined;
  if (type && !matchesType(type, value)) {
    errs.push({ path, message: `expected type ${type}, got ${typeOf(value)}` });
    return;
  }
  if ("const" in schema && value !== schema.const) {
    errs.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errs.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
  }
  if (type === "integer" && typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
    errs.push({ path, message: `must be >= ${schema.minimum}` });
  }
  if (type === "string" && typeof value === "string" && schema.format === "date-time" && !ISO_DATE_RE.test(value)) {
    errs.push({ path, message: "must be an ISO-8601 date-time" });
  }
  if (type === "string" && typeof value === "string" && schema.format === "uri") {
    try { new URL(value); } catch { errs.push({ path, message: "must be a URI" }); }
  }
  if (type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const props = (schema.properties ?? {}) as Record<string, JSchema>;
    const required = (schema.required as string[] | undefined) ?? [];
    const additional = schema.additionalProperties;
    for (const key of required) {
      if (!(key in (value as Record<string, unknown>))) {
        errs.push({ path: path ? `${path}.${key}` : key, message: "is required" });
      }
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = path ? `${path}.${k}` : k;
      if (props[k]) {
        validateNode(props[k], v, child, errs);
      } else if (additional === false) {
        errs.push({ path: child, message: "is not allowed (additionalProperties: false)" });
      }
    }
  }
  if (type === "array" && Array.isArray(value) && schema.items && typeof schema.items === "object") {
    (value as unknown[]).forEach((el, i) =>
      validateNode(schema.items as JSchema, el, `${path}[${i}]`, errs),
    );
  }
}

export function validateAgainstSchema(
  schema: JSchema,
  payload: unknown,
): SchemaError[] {
  const errs: SchemaError[] = [];
  validateNode(schema, payload, "", errs);
  return errs;
}
