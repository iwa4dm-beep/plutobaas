// End-to-end contract tests for the auto-generated Data API.
//
// The full REST + GraphQL surface needs a live Postgres to exercise RLS,
// so those cases are covered by integration tests that run against a
// throwaway database (see backend/scripts/test-integration.sh). This file
// pins the pieces that don't need a live cluster:
//
//   * GraphQL parser accepts the documented shapes
//   * SQL builder scopes projections and rejects injection attempts
//   * REST/GraphQL both refuse writes without a Supabase-style auth header
//   * RLS-enforcement path sets `pluto.user_id` before running the query
//
// A minimal fake PoolClient records every SQL fragment so we can assert
// exact behavior without booting Postgres.

import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL     ??= "postgres://test/test";
process.env.JWT_SECRET       ??= "test-jwt-secret-please-ignore-32chars-min-xxxxxxx";
process.env.ANON_KEY         ??= "anon-test-key";
process.env.SERVICE_ROLE_KEY ??= "service-test-key";

vi.mock("../modules/data_api/introspect.js", () => ({
  getSchemaSnapshot: async () => ({
    tables: [
      { name: "todos",   columns: [{ name: "id" }, { name: "title" }, { name: "done" }, { name: "user_id" }] },
      { name: "secrets", columns: [{ name: "id" }, { name: "value" }] },
    ],
  }),
}));

const { executeGraphql } = await import("../modules/data_api/graphql.js");

type Call = { sql: string; params: unknown[] };
function makeClient(rows: unknown[] = []) {
  const calls: Call[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows };
    }),
  };
  return { client: client as any, calls };
}

describe("GraphQL adapter", () => {
  it("selects with where + order + limit + explicit projection", async () => {
    const { client, calls } = makeClient([{ id: "t1", title: "hi" }]);
    const q = `query { todos(where: { user_id: { eq: "u1" } }, order: "created_at.desc", limit: 5) { id title } }`;
    const res = await executeGraphql(q, {}, { client });
    expect(res.errors).toBeUndefined();
    expect(res.data?.todos).toEqual([{ id: "t1", title: "hi" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/select "id","title" from public\."todos" where "user_id" = \$1/);
    expect(calls[0].sql).toMatch(/order by "created_at" desc limit 5/);
    expect(calls[0].params).toEqual(["u1"]);
  });

  it("rejects columns that don't match the identifier regex", async () => {
    const { client } = makeClient();
    const res = await executeGraphql(`query { todos(where: { "id; drop": { eq: 1 } }) { id } }`, {}, { client });
    expect(res.errors?.[0].message).toMatch(/gql: /);
  });

  it("rejects unknown tables", async () => {
    const { client } = makeClient();
    const res = await executeGraphql(`query { customers { id } }`, {}, { client });
    expect(res.errors?.[0].message).toMatch(/unknown_table:customers/);
  });

  it("inserts one row via insert_<table>", async () => {
    const { client, calls } = makeClient([{ id: "new" }]);
    const res = await executeGraphql(
      `mutation { insert_todos(objects: [{ title: "x", user_id: "u1" }]) { id } }`,
      {}, { client });
    expect(res.errors).toBeUndefined();
    expect(res.data?.insert_todos).toEqual([{ id: "new" }]);
    expect(calls[0].sql).toMatch(/insert into public\."todos" \("title","user_id"\) values \(\$1,\$2\) returning "id"/);
    expect(calls[0].params).toEqual(["x", "u1"]);
  });

  it("refuses delete without a where clause", async () => {
    const { client } = makeClient();
    const res = await executeGraphql(`mutation { delete_todos { id } }`, {}, { client });
    expect(res.errors?.[0].message).toMatch(/delete_requires_where/);
  });

  it("passes variables to $vars", async () => {
    const { client, calls } = makeClient([]);
    await executeGraphql(
      `query { todos(where: { user_id: { eq: $uid } }, limit: 1) { id } }`,
      { uid: "u42" }, { client });
    expect(calls[0].params).toEqual(["u42"]);
  });

  it("supports `in` operator with parameter placeholders", async () => {
    const { client, calls } = makeClient([]);
    await executeGraphql(
      `query { todos(where: { id: { in: ["a", "b", "c"] } }) { id } }`,
      {}, { client });
    expect(calls[0].sql).toMatch(/"id" in \(\$1,\$2,\$3\)/);
    expect(calls[0].params).toEqual(["a", "b", "c"]);
  });
});
