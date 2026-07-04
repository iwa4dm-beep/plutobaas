// Phase 52 — Data API v3 tests. Cover nested-write planner ordering,
// schema cache digest invalidation, and TypeScript codegen output.

import { describe, it, expect, beforeEach } from "vitest";
import { planNestedInsert, type Schema } from "../lib/nested-writes.js";
import { getSchema, invalidate, digestOf, _reset, _size } from "../lib/schema-cache.js";
import { generateTypes, type SchemaWithTypes } from "../lib/type-gen.js";

const schema: Schema = {
  posts: {
    table: "posts",
    columns: ["id", "title", "author_id"],
    relations: {
      author: { name: "author", kind: "belongs_to", target_table: "users", local_column: "author_id", target_column: "id" },
      tags:   { name: "tags",   kind: "has_many",   target_table: "post_tags", local_column: "post_id",  target_column: "id" },
    },
  },
  users:     { table: "users",     columns: ["id", "name"], relations: {} },
  post_tags: { table: "post_tags", columns: ["id", "post_id", "label"], relations: {} },
};

describe("nested-write planner", () => {
  it("orders inserts parent → self → children with correct refs", () => {
    const plan = planNestedInsert(schema, "posts", {
      title: "hello",
      author: { name: "u" },
      tags: [{ label: "a" }, { label: "b" }],
    });
    // Expected: author (step 0), post (step 1), tag a (step 2), tag b (step 3)
    expect(plan.steps[0].table).toBe("users");
    expect(plan.steps[1].table).toBe("posts");
    expect(plan.steps[1].refs?.[0]).toEqual({ column: "author_id", from_step: 0, from_column: "id" });
    expect(plan.steps[2].table).toBe("post_tags");
    expect(plan.steps[2].refs?.[0].from_step).toBe(1);
    expect(plan.steps[3].table).toBe("post_tags");
    expect(plan.root_step).toBe(1);
  });

  it("rejects malformed nested payload", () => {
    expect(() => planNestedInsert(schema, "posts", { tags: { label: "a" } })).toThrow(/bad_has_many/);
    expect(() => planNestedInsert(schema, "posts", { author: [{ name: "u" }] })).toThrow(/bad_belongs_to/);
  });
});

describe("schema cache", () => {
  beforeEach(() => _reset());

  it("caches by workspace and reports cache hits", async () => {
    let calls = 0;
    const loader = async () => { calls++; return schema; };
    const a = await getSchema("ws1", "public", loader);
    const b = await getSchema("ws1", "public", loader);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(calls).toBe(1);
    expect(a.digest).toBe(b.digest);
  });

  it("invalidates by workspace or name", async () => {
    await getSchema("ws2", "public", async () => schema);
    await getSchema("ws2", "internal", async () => schema);
    expect(_size()).toBe(2);
    expect(invalidate("ws2", "public")).toBe(1);
    expect(invalidate("ws2")).toBe(1);
    expect(_size()).toBe(0);
  });

  it("digest changes when schema changes", () => {
    const d1 = digestOf(schema);
    const modified: Schema = { ...schema, users: { ...schema.users, columns: ["id", "name", "email"] } };
    expect(digestOf(modified)).not.toBe(d1);
  });
});

describe("TypeScript codegen", () => {
  it("emits interfaces, computed fields, and relations", () => {
    const desc: SchemaWithTypes = {
      posts: {
        table: "posts",
        columns_meta: [
          { name: "id", type: "uuid" },
          { name: "title", type: "text" },
          { name: "author_id", type: "uuid", nullable: true },
        ],
        relations: schema.posts.relations,
        computed: [{ name: "word_count", ts_type: "number" }],
      },
      users: { table: "users", columns_meta: [{ name: "id", type: "uuid" }, { name: "name", type: "text" }], relations: {} },
      post_tags: { table: "post_tags", columns_meta: [{ name: "id", type: "uuid" }, { name: "label", type: "text" }], relations: {} },
    };
    const out = generateTypes(desc);
    expect(out).toContain("export interface Posts {");
    expect(out).toContain("author_id?: string | null");
    expect(out).toContain("word_count?: number");
    expect(out).toContain("author?: Users");
    expect(out).toContain("tags?: PostTags[]");
    expect(out).toContain("export type PostsInsert = Partial<Posts>;");
  });
});
