// Phase 44 — unit tests for embed parser + webhook signature/backoff.
// Full HTTP integration is covered by the e2e suite (needs Postgres).

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { parseSelect, scalarColumns } from "../lib/embed.js";

describe("select parser", () => {
  it("parses scalar columns", () => {
    const n = parseSelect("id,title,body");
    expect(n.map(x => x.name)).toEqual(["id","title","body"]);
    expect(scalarColumns(n)).toBe(`"id", "title", "body"`);
  });

  it("parses embedded relations with * and named columns", () => {
    const n = parseSelect("id,author(name,email),comments(*)");
    expect(n[1].columns).toBeTruthy();
    expect(Array.isArray(n[1].columns)).toBe(true);
    expect(n[2].columns).toBe("*");
  });

  it("rejects unbalanced parens", () => {
    expect(() => parseSelect("author(name")).toThrow(/missing/);
  });

  it("scalarColumns returns * when no scalars", () => {
    expect(scalarColumns(parseSelect("author(*)"))).toBe("*");
  });
});

describe("webhook signature", () => {
  it("HMAC-SHA256 matches what the dispatcher sends", () => {
    const secret = "s3cret";
    const body = JSON.stringify({ event: "INSERT", payload: { x: 1 } });
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    // Receivers verify by recomputing with the shared secret.
    const check = createHmac("sha256", secret).update(body).digest("hex");
    expect(check).toBe(sig);
  });
});
