// Phase 45 — unit tests for the cron parser. The import resolver lives on
// top of the Kysely-backed cache so it's covered by the e2e suite instead.

import { describe, it, expect } from "vitest";
import { parseCron, nextRunAt } from "../lib/cron.js";

describe("cron parser", () => {
  it("parses every-minute", () => {
    const p = parseCron("* * * * *");
    expect(p.min.has(0) && p.min.has(59)).toBe(true);
  });

  it("parses step + range", () => {
    const p = parseCron("*/15 9-17 * * 1-5");
    expect([...p.min]).toEqual([0,15,30,45]);
    expect(p.hour.has(9) && p.hour.has(17) && !p.hour.has(8)).toBe(true);
    expect(p.dow.has(1) && p.dow.has(5) && !p.dow.has(0)).toBe(true);
  });

  it("rejects invalid field count", () => {
    expect(() => parseCron("* * *")).toThrow(/5 fields/);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
  });

  it("next-run advances forward to top of hour", () => {
    const p = parseCron("0 * * * *");
    const from = new Date("2026-07-04T10:15:00Z");
    expect(nextRunAt(p, from).toISOString()).toBe("2026-07-04T11:00:00.000Z");
  });
});

