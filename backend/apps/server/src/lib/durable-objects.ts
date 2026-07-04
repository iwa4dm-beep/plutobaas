// Phase 55 — Durable Objects.
// A DO is a single-writer stateful actor addressed by (class, id). All calls
// to the same id are serialized through a per-id FIFO queue, giving strong
// consistency for counters, rate limiters, room state, etc. The state map is
// snapshotted per id and returned to callers.

export type DoState = Record<string, unknown>;
export type DoCall = { method: string; args?: unknown };
export type DoResult = { ok: boolean; state: DoState; result?: unknown; error?: string };
export type DoHandler = (state: DoState, call: DoCall) => Promise<{ state: DoState; result?: unknown }> | { state: DoState; result?: unknown };

const classes = new Map<string, DoHandler>();
const states = new Map<string, DoState>();
const queues = new Map<string, Promise<unknown>>();
const key = (cls: string, id: string) => `${cls}::${id}`;

export function registerClass(cls: string, handler: DoHandler): void {
  classes.set(cls, handler);
}

/** Built-in "counter" class — used by tests and the default `/fn/v6/do/*` demo. */
registerClass("counter", (state, call) => {
  const cur = Number(state.value ?? 0);
  if (call.method === "inc") return { state: { value: cur + Number((call.args as { by?: number })?.by ?? 1) }, result: cur + 1 };
  if (call.method === "get") return { state, result: cur };
  if (call.method === "reset") return { state: { value: 0 }, result: 0 };
  throw new Error(`unknown_method:${call.method}`);
});

export async function callDo(cls: string, id: string, call: DoCall): Promise<DoResult> {
  const handler = classes.get(cls);
  if (!handler) return { ok: false, state: {}, error: `unknown_class:${cls}` };
  const k = key(cls, id);
  const prev = queues.get(k) ?? Promise.resolve();
  const next = prev.then(async () => {
    const state = states.get(k) ?? {};
    try {
      const r = await handler(state, call);
      states.set(k, r.state);
      return { ok: true, state: r.state, result: r.result } as DoResult;
    } catch (e) {
      return { ok: false, state, error: (e as Error).message } as DoResult;
    }
  });
  queues.set(k, next.catch(() => undefined));
  return next as Promise<DoResult>;
}

export function getState(cls: string, id: string): DoState | undefined {
  return states.get(key(cls, id));
}

export function clearDo(): void { states.clear(); queues.clear(); }
