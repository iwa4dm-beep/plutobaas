// Phase 53 — Warm-instance pool for edge WASM modules.
// Reduces cold-starts by keeping N pre-instantiated instances per
// (module, region). `acquire` returns a warm instance or spins up a fresh
// one (marked `cold`). `release` returns it to the pool up to `max_warm`.

export type PoolKey = string; // `${module}@${version}::${region}`
export type Instance = { id: string; createdAt: number; usedAt: number };

type Pool = { min: number; max: number; free: Instance[]; total: number };

const pools = new Map<PoolKey, Pool>();
let seq = 0;

export function poolKey(module: string, version: number, region: string): PoolKey {
  return `${module}@${version}::${region}`;
}

export function configure(key: PoolKey, min: number, max: number): void {
  const p = pools.get(key) ?? { min: 0, max: 1, free: [], total: 0 };
  p.min = Math.max(0, min);
  p.max = Math.max(p.min, max);
  while (p.free.length < p.min) {
    p.free.push({ id: `inst_${++seq}`, createdAt: Date.now(), usedAt: Date.now() });
    p.total++;
  }
  pools.set(key, p);
}

export function acquire(key: PoolKey): { instance: Instance; cold: boolean } {
  const p = pools.get(key) ?? { min: 0, max: 1, free: [], total: 0 };
  pools.set(key, p);
  const warm = p.free.pop();
  if (warm) { warm.usedAt = Date.now(); return { instance: warm, cold: false }; }
  const fresh: Instance = { id: `inst_${++seq}`, createdAt: Date.now(), usedAt: Date.now() };
  p.total++;
  return { instance: fresh, cold: true };
}

export function release(key: PoolKey, inst: Instance): void {
  const p = pools.get(key);
  if (!p) return;
  if (p.free.length < p.max) p.free.push(inst);
  else p.total = Math.max(0, p.total - 1);
}

export function stats(key: PoolKey) {
  const p = pools.get(key);
  return p ? { free: p.free.length, total: p.total, min: p.min, max: p.max }
           : { free: 0, total: 0, min: 0, max: 0 };
}

export function clearPools(): void { pools.clear(); seq = 0; }
