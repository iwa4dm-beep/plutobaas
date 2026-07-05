// Sandbox worker — evaluates user code and posts back a serializable result.
// Runs in worker_threads with resourceLimits set by the parent.
// Available to user code: fetch, URL, TextEncoder/Decoder, console, atob, btoa, Response, Request, Headers.
// NOT provided: require, process, fs, child_process, worker_threads, __dirname, __filename.

import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

const { code, req, env, timeoutMs } = workerData;

const logs = [];
const safeConsole = {
  log:  (...a) => logs.push(['log',  a.map(fmt).join(' ')]),
  info: (...a) => logs.push(['info', a.map(fmt).join(' ')]),
  warn: (...a) => logs.push(['warn', a.map(fmt).join(' ')]),
  error:(...a) => logs.push(['error',a.map(fmt).join(' ')]),
};
function fmt(v) { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } }

// Minimal Request/Response polyfill using Web Fetch API (Node 20+ ships globalThis.Request/Response)
const Req = globalThis.Request;
const Res = globalThis.Response;
const H   = globalThis.Headers;
const F   = globalThis.fetch;

const ctx = {
  console: safeConsole,
  fetch: F,
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  Request: Req,
  Response: Res,
  Headers: H,
  atob: globalThis.atob,
  btoa: globalThis.btoa,
  Deno: { env: { get: (k) => env[k] } }, // Supabase-edge-compat helper
  ENV: env,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
vm.createContext(ctx);

async function main() {
  const wrapped = `
    ${code}
    ;globalThis.__handler = (typeof handler !== 'undefined' && handler)
      || (typeof default_1 !== 'undefined' && default_1)
      || (typeof exports !== 'undefined' && (exports.default || exports.handler));
  `;
  try {
    vm.runInContext(wrapped, ctx, { timeout: timeoutMs, displayErrors: true });
    const handler = ctx.__handler;
    if (typeof handler !== 'function') {
      return post({ status: 500, headers: {}, body: 'No handler exported. Define `handler(req)` or `export default`.', logs: dumpLogs() });
    }

    // Build a Request the handler can read
    const url = new URL(req.url);
    const request = new Req(url.toString(), {
      method: req.method,
      headers: req.headers,
      body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req.body,
    });
    // Attach claims for convenience
    Object.defineProperty(request, 'auth', { value: req.claims, enumerable: false });

    const p = Promise.resolve(handler(request, { env, claims: req.claims }));
    const timed = new Promise((_, rej) => setTimeout(() => rej(new Error('handler timeout')), timeoutMs));
    const result = await Promise.race([p, timed]);

    if (result instanceof Res) {
      const bodyText = await result.text();
      const headers = {};
      result.headers.forEach((v, k) => { headers[k] = v; });
      return post({ status: result.status, headers, body: bodyText, logs: dumpLogs() });
    }
    // If handler returned plain data
    return post({
      status: 200,
      headers: { 'content-type': typeof result === 'string' ? 'text/plain' : 'application/json' },
      body: typeof result === 'string' ? result : JSON.stringify(result),
      logs: dumpLogs(),
    });
  } catch (e) {
    return post({ status: 500, headers: {}, body: `Function error: ${e.message}`, logs: dumpLogs(), error: e.message });
  }
}

function dumpLogs() { return logs.map(([lvl, msg]) => `[${lvl}] ${msg}`); }
function post(r) { parentPort.postMessage({ duration_ms: 0, ...r }); }

main();
