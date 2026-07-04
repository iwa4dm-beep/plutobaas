// Phase 61 — Streaming embeddings.
//
// Accepts a large input array and emits embeddings incrementally as
// NDJSON frames using the Phase 59 streaming helper. Callers can honor
// per-request/per-batch caps by feeding the endpoint any size; this
// module splits the input into provider-safe batches, embeds each batch
// via a pluggable `embedder` (default returns deterministic pseudo
// vectors so tests do not hit the Lovable AI Gateway), and yields
// per-input rows so slow clients trigger the write-side backpressure in
// `streamNdjson`.

export type EmbeddingBatch = { indices: number[]; vectors: number[][]; model: string };
export type Embedder = (batch: string[]) => Promise<EmbeddingBatch>;

const DEFAULT_MODEL = "google/gemini-embedding-001";
const DEFAULT_BATCH_SIZE = 32;

// Deterministic pseudo-embedder used by tests + local dev. Real
// deployments override via `setEmbedder()` to call the Gateway.
let embedder: Embedder = async (batch) => ({
  indices: batch.map((_, i) => i),
  vectors: batch.map((s) => pseudoVector(s, 8)),
  model: `stub/${DEFAULT_MODEL}`,
});

export function setEmbedder(fn: Embedder) { embedder = fn; }
export function _resetEmbedderForTests() {
  embedder = async (batch) => ({
    indices: batch.map((_, i) => i),
    vectors: batch.map((s) => pseudoVector(s, 8)),
    model: `stub/${DEFAULT_MODEL}`,
  });
}

function pseudoVector(s: string, dims: number): number[] {
  const out = new Array<number>(dims).fill(0);
  for (let i = 0; i < s.length; i++) out[i % dims] = (out[i % dims] + s.charCodeAt(i)) % 997;
  const norm = Math.sqrt(out.reduce((a, b) => a + b * b, 0)) || 1;
  return out.map((v) => v / norm);
}

export type StreamedEmbedding = { index: number; embedding: number[]; model: string; token_estimate: number };

export async function* embedStream(
  inputs: string[],
  opts: { batch_size?: number } = {},
): AsyncGenerator<StreamedEmbedding> {
  const batch = Math.max(1, Math.min(100, opts.batch_size ?? DEFAULT_BATCH_SIZE));
  for (let start = 0; start < inputs.length; start += batch) {
    const chunk = inputs.slice(start, start + batch);
    const res = await embedder(chunk);
    for (let i = 0; i < res.vectors.length; i++) {
      yield {
        index: start + res.indices[i],
        embedding: res.vectors[i],
        model: res.model,
        token_estimate: Math.max(1, Math.ceil(chunk[i].length / 4)),
      };
    }
  }
}
