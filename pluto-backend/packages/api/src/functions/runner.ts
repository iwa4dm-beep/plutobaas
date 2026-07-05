import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type RunResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
  logs: string[];
  duration_ms: number;
  error?: string;
};

export type FnRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  claims: any | null;
};

/**
 * Run user JS in an isolated worker_threads sandbox.
 * Blocks: net/fs/child_process by leaving `require`/`process.env`/globals limited in the worker script.
 */
export function runFunction(
  code: string,
  req: FnRequest,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const workerPath = join(__dirname, 'sandbox-worker.mjs');
    let settled = false;

    const worker = new Worker(workerPath, {
      workerData: { code, req, env, timeoutMs },
      // Restrict resources at OS level as much as Node allows
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        codeRangeSizeMb: 16,
      },
      // Disable child threads inside the sandbox
      env: {} as any,
    });

    const kill = (result: RunResult) => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      resolve({ ...result, duration_ms: Date.now() - t0 });
    };

    const killer = setTimeout(() => {
      kill({ status: 504, headers: {}, body: 'Function timed out', logs: [], duration_ms: 0, error: 'timeout' });
    }, timeoutMs + 500);

    worker.on('message', (m: RunResult) => {
      clearTimeout(killer);
      kill(m);
    });
    worker.on('error', (e) => {
      clearTimeout(killer);
      kill({ status: 500, headers: {}, body: String(e.message), logs: [], duration_ms: 0, error: e.message });
    });
    worker.on('exit', (code) => {
      if (!settled) {
        clearTimeout(killer);
        kill({ status: 500, headers: {}, body: `worker exited with ${code}`, logs: [], duration_ms: 0, error: `exit_${code}` });
      }
    });
  });
}
