// Phase 46 — Hybrid search + Reciprocal Rank Fusion (RRF).
//
// Hybrid search fuses two independently ranked lists — vector similarity
// and BM25/tsvector full-text — using RRF:
//
//   score(doc) = sum_over_lists( 1 / (k + rank_in_list) )
//
// RRF is the boring-and-works fusion algorithm from TREC. `k` defaults to
// 60 which is the canonical value in the literature.

export type Ranked<T> = { id: string; score: number; doc: T };

export function rrf<T>(
  lists: Array<Array<{ id: string; doc: T }>>,
  opts: { k?: number; topK?: number } = {},
): Ranked<T>[] {
  const k = opts.k ?? 60;
  const acc = new Map<string, { score: number; doc: T }>();
  for (const list of lists) {
    list.forEach((row, i) => {
      const rank = i + 1;
      const cur = acc.get(row.id);
      if (cur) cur.score += 1 / (k + rank);
      else acc.set(row.id, { score: 1 / (k + rank), doc: row.doc });
    });
  }
  return [...acc.entries()]
    .map(([id, { score, doc }]) => ({ id, score, doc }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK ?? 20);
}
