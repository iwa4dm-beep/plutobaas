# Data API v3 — Phase 52

Nested writes, computed fields, generated TypeScript types, and a
schema introspection cache. Enable with `PLUTO_ENABLE_DATA_API_V3=1`.

## Endpoints (require API key)

### Nested writes

```
POST /rest/v3/plan-nested
{ "workspace": "ws1", "schema_name": "public", "root_table": "posts",
  "payload": { "title": "hi", "author": { "name": "u" },
               "tags": [ { "label": "a" } ] } }
→ 200 { ok, plan: { steps: [ { op, table, columns, refs?, label } ], root_step } }
```

The plan is a topologically ordered list of `insert` steps. Execute it
inside a single transaction and thread returned IDs through `refs`.

### Computed fields

```
POST /rest/v3/computed
{ "workspace": "ws1", "schema_name": "public", "table": "posts",
  "field_name": "word_count", "sql_expr": "array_length(regexp_split_to_array(body,'\\s+'),1)",
  "ts_type": "number" }
→ 200 { ok, field }

GET  /rest/v3/computed?workspace=ws1&schema_name=public&table=posts
→ 200 { fields: [...] }
```

### Schema cache

```
POST /rest/v3/schema/register
{ "workspace": "ws1", "name": "public", "descriptor": { <table>: {...} } }
→ 200 { ok, digest, tables }

GET  /rest/v3/schema/:name?workspace=ws1
→ 200 { name, cached, digest, descriptor }

POST /rest/v3/schema/invalidate
{ "workspace": "ws1", "name": "public" }        # or omit name to clear workspace
→ 200 { ok, removed }
```

### Generated types

```
GET /rest/v3/types/:name?workspace=ws1
→ 200 (text/typescript) — interfaces + `<Table>Insert` aliases
```

## Descriptor shape

```jsonc
{
  "posts": {
    "table": "posts",
    "columns_meta": [
      { "name": "id",        "type": "uuid" },
      { "name": "title",     "type": "text" },
      { "name": "author_id", "type": "uuid", "nullable": true }
    ],
    "relations": {
      "author": { "name": "author", "kind": "belongs_to",
                  "target_table": "users",
                  "local_column": "author_id", "target_column": "id" },
      "tags":   { "name": "tags",   "kind": "has_many",
                  "target_table": "post_tags",
                  "local_column": "post_id",  "target_column": "id" }
    }
  }
}
```

## Notes

- Descriptors are held in-memory per (workspace, name); durable storage
  is in migration `0050_phase52_data_api_v3.sql`
  (`dapi3_computed_fields`, `dapi3_schema_cache`).
- Digests are deterministic — clients can compare local vs server
  digest to decide whether to refetch generated types.
- Computed field SQL runs in the reader (`/rest/v2/embed`); it is
  evaluated by Postgres, so keep expressions side-effect free.
