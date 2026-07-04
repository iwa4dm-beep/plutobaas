// Phase 61 — Per-tenant HNSW tuning.
//
// Stores HNSW parameters per (workspace, index_name) with validation
// bounds so a bad config cannot silently degrade the whole cluster.
// Callers translate the config into DDL when creating/rebuilding the
// index; this module only owns the settings + validation.

export type HnswParams = {
  m: number;                // graph fan-out (2..64)
  ef_construction: number;  // build-time candidates (4..1024)
  ef_search: number;        // query-time candidates (1..2048)
  metric: "cosine" | "l2" | "ip";
};

export type HnswConfig = HnswParams & {
  workspace_id: string;
  index_name: string;
  updated_at: number;
};

const DEFAULTS: HnswParams = { m: 16, ef_construction: 200, ef_search: 64, metric: "cosine" };
const configs = new Map<string, HnswConfig>();
const key = (ws: string, idx: string) => `${ws}::${idx}`;

export class HnswValidationError extends Error {}

function validate(p: Partial<HnswParams>): void {
  if (p.m !== undefined && (p.m < 2 || p.m > 64)) throw new HnswValidationError("m_out_of_range");
  if (p.ef_construction !== undefined && (p.ef_construction < 4 || p.ef_construction > 1024))
    throw new HnswValidationError("ef_construction_out_of_range");
  if (p.ef_search !== undefined && (p.ef_search < 1 || p.ef_search > 2048))
    throw new HnswValidationError("ef_search_out_of_range");
  if (p.metric !== undefined && !["cosine", "l2", "ip"].includes(p.metric))
    throw new HnswValidationError("bad_metric");
}

export function setHnswConfig(workspace_id: string, index_name: string, params: Partial<HnswParams>): HnswConfig {
  validate(params);
  const existing = configs.get(key(workspace_id, index_name));
  const merged: HnswConfig = {
    workspace_id, index_name,
    ...(existing ?? DEFAULTS),
    ...params,
    updated_at: Date.now(),
  } as HnswConfig;
  configs.set(key(workspace_id, index_name), merged);
  return merged;
}

export function getHnswConfig(workspace_id: string, index_name: string): HnswConfig {
  return configs.get(key(workspace_id, index_name)) ?? { workspace_id, index_name, ...DEFAULTS, updated_at: 0 };
}

export function listHnswConfigs(workspace_id: string): HnswConfig[] {
  return Array.from(configs.values()).filter((c) => c.workspace_id === workspace_id);
}

export function ddlFor(config: HnswConfig, table: string, column: string): string {
  const op = config.metric === "cosine" ? "vector_cosine_ops" : config.metric === "l2" ? "vector_l2_ops" : "vector_ip_ops";
  return `create index if not exists ${config.index_name} on public."${table}" using hnsw ("${column}" ${op}) with (m = ${config.m}, ef_construction = ${config.ef_construction});`;
}

export function _resetHnswForTests() { configs.clear(); }
