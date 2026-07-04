// Phase 46 — unit tests for RRF fusion + text chunking.

import { describe, it, expect } from "vitest";
import { rrf } from "../lib/rrf.js";
import { chunkText } from "../lib/lovable-embeddings.js";

describe("RRF fusion", () => {
  it("boosts items appearing in both lists", () => {
    const vector = [{ id: "a", doc: 1 }, { id: "b", doc: 2 }, { id: "c", doc: 3 }];
    const fulltext = [{ id: "b", doc: 2 }, { id: "d", doc: 4 }, { id: "a", doc: 1 }];
    const out = rrf([vector, fulltext], { topK: 4 });
    // a and b appear in both — should top c and d
    expect(out[0].id === "a" || out[0].id === "b").toBe(true);
    const top2 = new Set(out.slice(0, 2).map(x => x.id));
    expect(top2.has("a") && top2.has("b")).toBe(true);
  });

  it("preserves single-list order when only one list is provided", () => {
    const out = rrf([[{ id: "x", doc: 1 }, { id: "y", doc: 2 }]], { topK: 2 });
    expect(out.map(o => o.id)).toEqual(["x", "y"]);
  });
});

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    expect(chunkText("hi", 100, 10)).toEqual(["hi"]);
  });

  it("splits with overlap", () => {
    const text = "a".repeat(300);
    const chunks = chunkText(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].length).toBe(100);
    // Consecutive chunks overlap by `overlap` chars.
    expect(chunks[0].slice(-20)).toBe(chunks[1].slice(0, 20));
  });
});
