// Phase 62 unit tests — DAG scheduling, retry semantics, exactly-once side effects.
import { describe, it, expect, beforeEach } from "vitest";
import {
  runWorkflow, _resetJobsForTests, _sideEffectCountForTests,
  type WorkflowDef,
} from "../lib/workflow-engine.js";

beforeEach(() => _resetJobsForTests());

describe("workflow DAG scheduling", () => {
  it("runs steps in topological order and passes upstream outputs", async () => {
    const wf: WorkflowDef<{ n: number }> = {
      name: "add-chain", version: 1,
      steps: [
        { id: "a", run: async ({ input }) => input.n + 1 },
        { id: "b", deps: ["a"], run: async ({ outputs }) => (outputs.a as number) * 2 },
        { id: "c", deps: ["b"], run: async ({ outputs }) => (outputs.b as number) + 100 },
      ],
    };
    const run = await runWorkflow(wf, { n: 5 });
    expect(run.status).toBe("succeeded");
    expect(run.steps.c.output).toBe(112);
  });

  it("runs independent steps concurrently", async () => {
    const started: number[] = [];
    const wf: WorkflowDef = {
      name: "fanout", version: 1,
      steps: ["a", "b", "c"].map((id) => ({
        id,
        run: async () => { started.push(Date.now()); await new Promise((r) => setTimeout(r, 20)); return id; },
      })),
    };
    const t0 = Date.now();
    const run = await runWorkflow(wf, {});
    expect(run.status).toBe("succeeded");
    // Should run in a single wave (~20ms), not sequentially (~60ms).
    expect(Date.now() - t0).toBeLessThan(55);
  });

  it("detects cycles", async () => {
    const wf: WorkflowDef = {
      name: "cyc", version: 1,
      steps: [
        { id: "a", deps: ["b"], run: async () => 1 },
        { id: "b", deps: ["a"], run: async () => 2 },
      ],
    };
    await expect(runWorkflow(wf, {})).rejects.toThrow(/cycle_detected/);
  });

  it("skips downstream steps when an upstream fails", async () => {
    const wf: WorkflowDef = {
      name: "fail-cascade", version: 1,
      steps: [
        { id: "a", run: async () => { throw new Error("boom"); } },
        { id: "b", deps: ["a"], run: async () => 42 },
      ],
    };
    const run = await runWorkflow(wf, {});
    expect(run.status).toBe("failed");
    expect(run.steps.a.status).toBe("failed");
    expect(run.steps.b.status).toBe("skipped");
  });
});

describe("retry semantics", () => {
  it("retries a failing step up to max_attempts, then succeeds", async () => {
    let calls = 0;
    const wf: WorkflowDef = {
      name: "retry-ok", version: 1,
      steps: [{
        id: "flaky",
        retry: { max_attempts: 3, backoff_ms: 0 },
        run: async () => { calls++; if (calls < 3) throw new Error("nope"); return "ok"; },
      }],
    };
    const run = await runWorkflow(wf, {});
    expect(run.status).toBe("succeeded");
    expect(run.steps.flaky.attempts).toBe(3);
    expect(run.steps.flaky.output).toBe("ok");
  });

  it("gives up after max_attempts and marks the step failed", async () => {
    const wf: WorkflowDef = {
      name: "retry-fail", version: 1,
      steps: [{
        id: "always",
        retry: { max_attempts: 2, backoff_ms: 0 },
        run: async () => { throw new Error("permanent"); },
      }],
    };
    const run = await runWorkflow(wf, {});
    expect(run.status).toBe("failed");
    expect(run.steps.always.attempts).toBe(2);
  });
});

describe("exactly-once side effects", () => {
  it("does not re-execute a side effect across retries", async () => {
    let calls = 0;
    let attempts = 0;
    const wf: WorkflowDef = {
      name: "se-once", version: 1,
      steps: [{
        id: "charge",
        retry: { max_attempts: 3, backoff_ms: 0 },
        run: async ({ sideEffect }) => {
          attempts++;
          const receipt = await sideEffect("charge_card", async () => {
            calls++;
            return { receipt_id: "R123" };
          });
          if (attempts < 2) throw new Error("post-charge failure");
          return receipt;
        },
      }],
    };
    const run = await runWorkflow(wf, {});
    expect(run.status).toBe("succeeded");
    expect(calls).toBe(1);        // charge only happened once
    expect(attempts).toBe(2);     // outer step retried
    expect(_sideEffectCountForTests()).toBe(1);
  });

  it("scopes side effects per run_id + step_id + key", async () => {
    let calls = 0;
    const wf: WorkflowDef = {
      name: "se-scope", version: 1,
      steps: [{
        id: "s",
        run: async ({ sideEffect }) => sideEffect("k", async () => { calls++; return calls; }),
      }],
    };
    const a = await runWorkflow(wf, {}, "runA");
    const b = await runWorkflow(wf, {}, "runB");
    expect(a.steps.s.output).toBe(1);
    expect(b.steps.s.output).toBe(2);
    expect(calls).toBe(2);
  });
});
