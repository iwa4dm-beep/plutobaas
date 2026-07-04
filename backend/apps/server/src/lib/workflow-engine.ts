// Phase 62 — Durable workflow engine with DAG scheduling.
//
// A workflow is a DAG of steps. Each step declares dependencies; the
// scheduler runs steps in topological order and executes independent
// steps concurrently. Step results are memoized per (run_id, step_id)
// so retries never re-execute a step that already committed. Side-effect
// steps use an idempotency ledger keyed by (run_id, step_id,
// side_effect_key) so a retried side effect is only observed once.

export type StepFn<Ctx = unknown> = (ctx: StepContext<Ctx>) => Promise<unknown>;

export type StepDef<Ctx = unknown> = {
  id: string;
  deps?: string[];
  run: StepFn<Ctx>;
  retry?: { max_attempts: number; backoff_ms: number };
  side_effect_key?: string; // optional idempotency-key template
};

export type WorkflowDef<Ctx = unknown> = {
  name: string;
  version: number;
  steps: StepDef<Ctx>[];
};

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type StepRecord = {
  step_id: string;
  status: StepStatus;
  attempts: number;
  started_at?: number;
  ended_at?: number;
  output?: unknown;
  error?: string;
};

export type RunState<Ctx = unknown> = {
  run_id: string;
  workflow: string;
  version: number;
  status: "pending" | "running" | "succeeded" | "failed";
  input: Ctx;
  steps: Record<string, StepRecord>;
  started_at: number;
  ended_at?: number;
};

export type StepContext<Ctx = unknown> = {
  run_id: string;
  input: Ctx;
  step_id: string;
  attempt: number;
  outputs: Record<string, unknown>; // outputs of upstream steps by id
  sideEffect<T>(key: string, fn: () => Promise<T>): Promise<T>;
};

const runs = new Map<string, RunState>();
const sideEffects = new Map<string, unknown>(); // key: `${run_id}::${step_id}::${key}`

function seKey(run_id: string, step_id: string, key: string) { return `${run_id}::${step_id}::${key}`; }

function topoSort(steps: StepDef[]): string[] {
  const indeg = new Map<string, number>();
  const graph = new Map<string, string[]>();
  for (const s of steps) { indeg.set(s.id, 0); graph.set(s.id, []); }
  for (const s of steps) for (const d of s.deps ?? []) {
    if (!indeg.has(d)) throw new Error(`unknown_dep:${d}`);
    indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
    graph.get(d)!.push(s.id);
  }
  const q: string[] = []; indeg.forEach((v, k) => { if (v === 0) q.push(k); });
  const order: string[] = [];
  while (q.length) {
    const n = q.shift()!;
    order.push(n);
    for (const m of graph.get(n) ?? []) {
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) q.push(m);
    }
  }
  if (order.length !== steps.length) throw new Error("cycle_detected");
  return order;
}

async function runStep<Ctx>(
  wf: WorkflowDef<Ctx>, run: RunState<Ctx>, step: StepDef<Ctx>,
): Promise<void> {
  const rec = run.steps[step.id];
  rec.status = "running"; rec.started_at = Date.now();
  const maxAttempts = step.retry?.max_attempts ?? 1;
  const backoff = step.retry?.backoff_ms ?? 0;

  const outputs: Record<string, unknown> = {};
  for (const d of step.deps ?? []) outputs[d] = run.steps[d]?.output;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    rec.attempts = attempt;
    const ctx: StepContext<Ctx> = {
      run_id: run.run_id, input: run.input, step_id: step.id, attempt, outputs,
      async sideEffect<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const k = seKey(run.run_id, step.id, key);
        if (sideEffects.has(k)) return sideEffects.get(k) as T;
        const val = await fn();
        sideEffects.set(k, val);
        return val;
      },
    };
    try {
      rec.output = await step.run(ctx);
      rec.status = "succeeded"; rec.ended_at = Date.now();
      return;
    } catch (e) {
      rec.error = (e as Error).message;
      if (attempt >= maxAttempts) {
        rec.status = "failed"; rec.ended_at = Date.now();
        throw e;
      }
      if (backoff > 0) await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

export async function runWorkflow<Ctx>(wf: WorkflowDef<Ctx>, input: Ctx, run_id?: string): Promise<RunState<Ctx>> {
  const id = run_id ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const order = topoSort(wf.steps as any);
  const stepsById = new Map(wf.steps.map((s) => [s.id, s]));
  const run: RunState<Ctx> = {
    run_id: id, workflow: wf.name, version: wf.version, status: "running",
    input, steps: Object.fromEntries(wf.steps.map((s) => [s.id, { step_id: s.id, status: "pending" as StepStatus, attempts: 0 }])),
    started_at: Date.now(),
  };
  runs.set(id, run as RunState);

  // Level-schedule: run steps in waves of the same topological "level" concurrently.
  const remaining = new Set(order);
  while (remaining.size) {
    const ready = [...remaining].filter((id) => (stepsById.get(id)!.deps ?? []).every((d) => run.steps[d].status === "succeeded" || run.steps[d].status === "skipped"));
    if (ready.length === 0) {
      // Any pending step whose upstream failed → skip it.
      for (const id of remaining) {
        const deps = stepsById.get(id)!.deps ?? [];
        if (deps.some((d) => run.steps[d].status === "failed")) {
          run.steps[id].status = "skipped";
          remaining.delete(id);
        }
      }
      if (ready.length === 0 && [...remaining].every((id) => run.steps[id].status === "skipped")) break;
      break;
    }
    await Promise.allSettled(ready.map(async (id) => {
      try { await runStep(wf, run, stepsById.get(id)!); }
      catch { /* recorded on step */ }
      remaining.delete(id);
    }));
  }

  const anyFailed = Object.values(run.steps).some((s) => s.status === "failed");
  run.status = anyFailed ? "failed" : "succeeded";
  run.ended_at = Date.now();
  return run;
}

export function getRun(run_id: string): RunState | undefined { return runs.get(run_id); }
export function listRuns(): RunState[] { return Array.from(runs.values()); }

export function _resetJobsForTests() { runs.clear(); sideEffects.clear(); }
export function _sideEffectCountForTests() { return sideEffects.size; }
