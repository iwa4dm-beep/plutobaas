// Phase 35 — hardened edge-function invoker.
//
// Runs user code inside a worker_thread with:
//   * `vm.createContext` sandbox (no process/require/Buffer)
//   * `codeGeneration.strings = false` and `wasm = false`
//     (no eval, new Function, WebAssembly.compile at runtime)
//   * wall-clock deadline enforced by `worker.terminate()`
//   * heap cap via `resourceLimits.maxOldGenerationSizeMb`
//   * per-invocation `fetch` allow-list
//
// A worker per invocation is heavier than a pooled isolate but it makes
// deadline enforcement bullet-proof — a runaway loop cannot poison the
// shared event loop because we hard-kill the worker.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type InvokeInput = {
  code: string;
  req: { method: string; url: string; headers: Record<string, string>; body?: unknown };
  ctx: Record<string, unknown>;
  timeoutMs: number;
  memoryMb: number;
  allowHosts: string[];
};

export type InvokeResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  memPeakMb: number;
  logs: { level: string; args: string[] }[];
};

const WORKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "edge", "isolate-worker.cjs",
);

export async function invokeIsolate(input: InvokeInput): Promise<InvokeResult> {
  const logs: { level: string; args: string[] }[] = [];
  const started = Date.now();
  const w = new Worker(WORKER_PATH, {
    workerData: {
      code: input.code, req: input.req, ctx: input.ctx,
      allowHosts: input.allowHosts,
    },
    resourceLimits: {
      maxOldGenerationSizeMb: input.memoryMb,
      maxYoungGenerationSizeMb: Math.max(8, Math.floor(input.memoryMb / 4)),
      codeRangeSizeMb: 32,
    },
  });

  return await new Promise<InvokeResult>((resolve) => {
    let done = false;
    const timer = setTimeout(async () => {
      if (done) return; done = true;
      await w.terminate().catch(() => {});
      resolve({ ok: false, error: `deadline_${input.timeoutMs}ms`,
                durationMs: Date.now() - started, memPeakMb: 0, logs });
    }, input.timeoutMs);

    w.on("message", (m: { type: string; result?: unknown; message?: string; level?: string; args?: string[] }) => {
      if (m.type === "log") logs.push({ level: m.level ?? "info", args: m.args ?? [] });
      else if (m.type === "result" || m.type === "error") {
        if (done) return; done = true; clearTimeout(timer);
        w.terminate().catch(() => {});
        resolve({
          ok: m.type === "result",
          result: m.result, error: m.message,
          durationMs: Date.now() - started, memPeakMb: 0, logs,
        });
      }
    });
    w.on("error", (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: false, error: e.message, durationMs: Date.now() - started, memPeakMb: 0, logs });
    });
    w.on("exit", (code) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: false, error: `exit_${code}`, durationMs: Date.now() - started, memPeakMb: 0, logs });
    });
  });
}
