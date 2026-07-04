// Phase 53 — Queue triggers for edge functions.
// Producers enqueue jobs to a named queue; each queue is bound to zero or
// more (module, version) subscribers. `drainQueue` processes pending jobs
// FIFO and invokes the caller-supplied dispatcher. Real deployments would
// back this with SQS/NATS JetStream; the in-memory shim keeps tests hermetic.

export type QueueJob = { id: string; body: unknown; enqueued_at: number; attempts: number };
export type Subscriber = { module: string; version: number };

const queues = new Map<string, QueueJob[]>();
const bindings = new Map<string, Subscriber[]>();
let seq = 0;

export function bind(queue: string, sub: Subscriber): void {
  const list = bindings.get(queue) ?? [];
  if (!list.some((s) => s.module === sub.module && s.version === sub.version)) list.push(sub);
  bindings.set(queue, list);
}

export function subscribers(queue: string): Subscriber[] { return bindings.get(queue) ?? []; }

export function enqueue(queue: string, body: unknown): QueueJob {
  const job: QueueJob = { id: `qj_${++seq}`, body, enqueued_at: Date.now(), attempts: 0 };
  const list = queues.get(queue) ?? [];
  list.push(job);
  queues.set(queue, list);
  return job;
}

export function pending(queue: string): number { return (queues.get(queue) ?? []).length; }

export async function drain(
  queue: string,
  dispatch: (sub: Subscriber, job: QueueJob) => Promise<{ ok: boolean; error?: string }>,
  max = 100,
): Promise<{ processed: number; failed: number }> {
  const list = queues.get(queue) ?? [];
  const subs = subscribers(queue);
  let processed = 0, failed = 0;
  for (let i = 0; i < Math.min(max, list.length); i++) {
    const job = list.shift()!;
    job.attempts++;
    let anyFail = false;
    for (const s of subs) {
      const r = await dispatch(s, job);
      if (!r.ok) anyFail = true;
    }
    if (anyFail) { failed++; list.push(job); } else processed++;
  }
  queues.set(queue, list);
  return { processed, failed };
}

export function clearQueues(): void { queues.clear(); bindings.clear(); seq = 0; }
