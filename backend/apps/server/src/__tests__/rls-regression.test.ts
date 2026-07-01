// CI regression: static analysis of every SQL migration to prove that
// each workspace-scoped table has RLS enabled AND at least one policy
// that filters by workspace_id / is_workspace_member(). The heavy
// lifting lives in scripts/check-rls.mjs; this test just runs it.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "scripts", "check-rls.mjs");

describe("rls regression (static)", () => {
  it("every public table has RLS + workspace-aware policies", () => {
    let out = "";
    try {
      out = execFileSync("node", [script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { stderr?: Buffer | string; stdout?: Buffer | string };
      const combined = (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "");
      throw new Error("RLS check failed:\n" + combined);
    }
    expect(out).toMatch(/RLS regression check passed/);
  });
});
