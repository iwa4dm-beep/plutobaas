// Edge-function isolate worker.
//
// Runs a single user-authored handler inside a dedicated Node worker
// thread. The worker exists ONLY for this invocation — we terminate it
// after the deadline or when the resource cap trips, so a runaway
// function cannot poison the shared event loop.
//
// Hardening applied here:
//   * `vm.createContext` with a whitelist of globals — no `process`,
//     `require`, `Buffer`, `setImmediate`, `globalThis.eval` at top level.
//   * `codeGeneration.strings = false` / `wasm = false` disables
//     runtime `eval`/`new Function`/WebAssembly.compile inside the vm.
//   * Wall-clock deadline enforced by the parent via `worker.terminate()`.
//   * Heap cap enforced via `resourceLimits.maxOldGenerationSizeMb`.
//   * Optional fetch allow-list checked here before any network call.

const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const { code, req, ctx, allowHosts } = workerData;

function guardedFetch(input, init) {
  try {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (allowHosts && allowHosts.length > 0 && !allowHosts.includes(url.host)) {
      throw new Error(`fetch_blocked:${url.host}`);
    }
    return fetch(input, init);
  } catch (e) {
    return Promise.reject(e);
  }
}

const sandbox = {
  console: {
    log: (...a) => parentPort.postMessage({ type: "log", level: "info", args: a.map(String) }),
    warn: (...a) => parentPort.postMessage({ type: "log", level: "warn", args: a.map(String) }),
    error: (...a) => parentPort.postMessage({ type: "log", level: "error", args: a.map(String) }),
  },
  fetch: guardedFetch,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  crypto: globalThis.crypto,
  atob,
  btoa,
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5000)),
  clearTimeout,
  Promise,
  JSON,
  Math,
  Date,
  Response,
  Request,
  Headers,
};

const context = vm.createContext(sandbox, {
  name: "pluto-edge",
  codeGeneration: { strings: false, wasm: false },
});

const wrapped = `
  const module = { exports: {} };
  const exports = module.exports;
  ${code}
  ;module.exports.__default = module.exports.default ?? module.exports;
  module.exports;
`;

(async () => {
  try {
    const script = new vm.Script(wrapped, { filename: "edge-fn.js" });
    const mod = script.runInContext(context, { timeout: 500 });
    if (typeof mod.__default !== "function") throw new Error("no_default_export");
    const result = await mod.__default({ req, ctx });
    parentPort.postMessage({ type: "result", result });
  } catch (e) {
    parentPort.postMessage({ type: "error", message: e && e.message ? e.message : String(e) });
  }
})();
