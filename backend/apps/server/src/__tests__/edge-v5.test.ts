// Phase 53 — Edge v5 unit tests: WASM registry, warm pool, region router.
import { describe, it, expect, beforeEach } from "vitest";
import { registerModule, getModule, hashWasm, clearRegistry, listModules } from "../lib/wasm-registry.js";
import { configure, acquire, release, poolKey, stats, clearPools } from "../lib/warm-pool.js";
import { pickDeployment, type Deployment } from "../lib/region-router.js";

const wasmStub = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]); // valid WASM header

beforeEach(() => { clearRegistry(); clearPools(); });

describe("wasm-registry", () => {
  it("hashes deterministically and stores modules", () => {
    const h1 = hashWasm(wasmStub);
    const h2 = hashWasm(wasmStub);
    expect(h1).toBe(h2);
    const m = registerModule({ name: "hello", version: 1, entry: "handler", wasm: wasmStub });
    expect(m.sha256).toBe(h1);
    expect(getModule("hello", 1)?.id).toBe(m.id);
    expect(listModules()).toHaveLength(1);
  });
});

describe("warm-pool", () => {
  it("min_warm instances are pre-created and reused", () => {
    const k = poolKey("hello", 1, "us-east");
    configure(k, 2, 4);
    const a = acquire(k);
    const b = acquire(k);
    expect(a.cold).toBe(false);
    expect(b.cold).toBe(false);
    const c = acquire(k); // pool empty → cold
    expect(c.cold).toBe(true);
    release(k, a.instance);
    const d = acquire(k);
    expect(d.cold).toBe(false); // reused
    expect(stats(k).max).toBe(4);
  });
});

describe("region-router", () => {
  const deps: Deployment[] = [
    { region: "us-east", module: "h", version: 1, status: "active" },
    { region: "eu-west", module: "h", version: 1, status: "active" },
    { region: "ap-northeast", module: "h", version: 1, status: "draining" },
  ];
  it("prefers same region", () => {
    expect(pickDeployment(deps, "eu-west")?.region).toBe("eu-west");
  });
  it("falls back to neighbor when exact region missing", () => {
    expect(pickDeployment(deps, "eu-central")?.region).toBe("eu-west");
  });
  it("skips non-active deployments", () => {
    expect(pickDeployment(deps, "ap-northeast")?.region).toBe("us-east"); // neighbor fallback via us-west→us-east chain
  });
  it("returns null when no active deployment", () => {
    expect(pickDeployment([{ region: "us-east", module: "h", version: 1, status: "retired" }], "us-east")).toBeNull();
  });
});
