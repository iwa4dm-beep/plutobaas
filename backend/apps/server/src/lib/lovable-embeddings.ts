// Phase 46 — Lovable AI Gateway embedding client.
//
// Thin OpenAI-compatible wrapper around POST /v1/embeddings. Handles
// - batching (Google caps at 100 inputs / request; OpenAI caps at 300k tokens)
// - retries on 429/5xx with exponential backoff + jitter
// - dimension override for openai/text-embedding-3-* via `dimensions`
//
// The API key stays server-side (LOVABLE_API_KEY). Never re-export this
// client to browser code.

const BASE = process.env.LOVABLE_AI_BASE_URL ?? "https://ai.gateway.lovable.dev";

export type EmbedInput = { texts: string[]; model: string; dimensions?: number };
export type EmbedResult = { vectors: number[][]; model: string; usage: { prompt_tokens: number } };

function batchSize(model: string): number {
  return model.startsWith("google/") ? 100 : 1024; // OpenAI has no strict item cap
}

export async function embedTexts(
  input: EmbedInput,
  opts: { apiKey?: string; fetchImpl?: typeof fetch; maxRetries?: number } = {},
): Promise<EmbedResult> {
  const key = opts.apiKey ?? process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY not set");
  const fetcher = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 4;

  const vectors: number[][] = [];
  let usage = 0;
  const cap = batchSize(input.model);

  for (let i = 0; i < input.texts.length; i += cap) {
    const chunk = input.texts.slice(i, i + cap);
    const body: Record<string, unknown> = { model: input.model, input: chunk };
    // `dimensions` is OpenAI-only; the gateway rejects it on google/*.
    if (input.dimensions && input.model.startsWith("openai/")) body.dimensions = input.dimensions;

    let lastErr: string | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetcher(`${BASE}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = await res.json() as {
          data: Array<{ embedding: number[]; index: number }>;
          usage?: { prompt_tokens?: number };
        };
        // Preserve original order — the provider returns `index` per input.
        const ordered = json.data.slice().sort((a, b) => a.index - b.index).map(d => d.embedding);
        vectors.push(...ordered);
        usage += json.usage?.prompt_tokens ?? 0;
        lastErr = null;
        break;
      }
      const retryable = res.status === 429 || res.status >= 500;
      lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 500);
      if (!retryable || attempt === maxRetries) throw new Error(`embed_failed: ${lastErr}`);
      const backoff = Math.min(30_000, 2 ** attempt * 500) + Math.random() * 250;
      await new Promise(r => setTimeout(r, backoff));
    }
    if (lastErr) throw new Error(lastErr);
  }
  return { vectors, model: input.model, usage: { prompt_tokens: usage } };
}

/** Split long text into chunks with overlap — token-agnostic char-based, good enough for retrieval. */
export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
    i += size - overlap;
  }
  return out;
}
