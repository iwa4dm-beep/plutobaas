// Phase 61 — Hybrid rerankers.
//
// Combines lexical (BM25-lite) and vector (cosine) scores into a single
// ranking. Supported strategies:
//   - `linear`  : score = alpha*vector + (1-alpha)*lexical
//   - `rrf`     : reciprocal-rank fusion, score = sum(1/(k+rank_i))
// Tie-breaking is deterministic: higher score, then lower `id`
// lexicographically, then lower insertion index — so results are stable
// across runs given the same inputs.

export type Candidate = {
  id: string;
  vector_score?: number; // higher = more similar (cosine similarity in [0,1])
  lexical_score?: number; // higher = better match (BM25-like)
  payload?: unknown;
};

export type RerankStrategy = "linear" | "rrf";

export type RerankOpts = {
  strategy: RerankStrategy;
  alpha?: number; // linear weight for vector score (0..1). Default 0.5.
  k?: number;    // RRF k. Default 60.
  limit?: number;
};

export type RerankedItem = { id: string; score: number; vector_score: number; lexical_score: number; payload?: unknown };

function normalize(scores: number[]): number[] {
  const min = Math.min(...scores, 0);
  const max = Math.max(...scores, 1);
  const span = max - min || 1;
  return scores.map((s) => (s - min) / span);
}

export function hybridRerank(cands: Candidate[], opts: RerankOpts): RerankedItem[] {
  if (cands.length === 0) return [];
  const indexed = cands.map((c, i) => ({ c, i }));
  if (opts.strategy === "linear") {
    const alpha = Math.max(0, Math.min(1, opts.alpha ?? 0.5));
    const vecN = normalize(indexed.map((x) => x.c.vector_score ?? 0));
    const lexN = normalize(indexed.map((x) => x.c.lexical_score ?? 0));
    const scored = indexed.map((x, idx) => ({
      id: x.c.id,
      vector_score: x.c.vector_score ?? 0,
      lexical_score: x.c.lexical_score ?? 0,
      payload: x.c.payload,
      score: alpha * vecN[idx] + (1 - alpha) * lexN[idx],
      insertion: idx,
    }));
    scored.sort(cmp);
    return finalize(scored, opts.limit);
  }
  // rrf
  const k = opts.k ?? 60;
  const byVec = [...indexed].sort((a, b) => (b.c.vector_score ?? 0) - (a.c.vector_score ?? 0));
  const byLex = [...indexed].sort((a, b) => (b.c.lexical_score ?? 0) - (a.c.lexical_score ?? 0));
  const rankV = new Map<string, number>(); byVec.forEach((x, r) => rankV.set(x.c.id, r + 1));
  const rankL = new Map<string, number>(); byLex.forEach((x, r) => rankL.set(x.c.id, r + 1));
  const scored = indexed.map((x, idx) => ({
    id: x.c.id,
    vector_score: x.c.vector_score ?? 0,
    lexical_score: x.c.lexical_score ?? 0,
    payload: x.c.payload,
    score: 1 / (k + (rankV.get(x.c.id) ?? indexed.length + 1)) + 1 / (k + (rankL.get(x.c.id) ?? indexed.length + 1)),
    insertion: idx,
  }));
  scored.sort(cmp);
  return finalize(scored, opts.limit);
}

function cmp(a: { score: number; id: string; insertion: number }, b: { score: number; id: string; insertion: number }) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.insertion - b.insertion;
}

function finalize<T extends { insertion: number }>(rows: T[], limit?: number): Omit<T, "insertion">[] {
  const trimmed = limit ? rows.slice(0, limit) : rows;
  return trimmed.map(({ insertion: _i, ...rest }) => rest);
}
