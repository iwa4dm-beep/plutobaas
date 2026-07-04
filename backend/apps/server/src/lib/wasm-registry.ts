// Phase 53 — WASM module registry (in-memory shadow of edge5_wasm_modules).
// Real Worker runtime would instantiate WebAssembly.Module from `wasm` and
// cache the compiled module keyed by sha256. This helper stays runtime-free
// so it works in unit tests and node/workerd alike.
import { createHash } from "node:crypto";

export type WasmModule = {
  id: string;
  name: string;
  version: number;
  sha256: string;
  size_bytes: number;
  entry: string;
  wasm: Uint8Array;
};

const modules = new Map<string, WasmModule>(); // key = `${name}@${version}`
const bySha = new Map<string, WasmModule>();

export function hashWasm(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function registerModule(input: Omit<WasmModule, "id" | "sha256" | "size_bytes">): WasmModule {
  const sha256 = hashWasm(input.wasm);
  const mod: WasmModule = {
    id: `mod_${sha256.slice(0, 12)}`,
    sha256,
    size_bytes: input.wasm.byteLength,
    ...input,
  };
  modules.set(`${mod.name}@${mod.version}`, mod);
  bySha.set(sha256, mod);
  return mod;
}

export function getModule(name: string, version: number): WasmModule | undefined {
  return modules.get(`${name}@${version}`);
}

export function getBySha(sha: string): WasmModule | undefined { return bySha.get(sha); }
export function listModules(): WasmModule[] { return [...modules.values()]; }
export function clearRegistry(): void { modules.clear(); bySha.clear(); }
