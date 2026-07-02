/**
 * Public types for the AI module (Phase 16).
 */

export type AiDriver = "lovable" | "openai" | "voyage" | "cohere" | "anthropic";
export type AiEndpoint = "embeddings" | "chat" | "vector.search";

export type AiProvider = {
  id: string;
  slug: string;
  driver: AiDriver;
  default_chat_model: string | null;
  default_embed_model: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
};

export type EmbeddingsRequest = {
  input: string | string[];
  model?: string;
  provider?: string;   // provider slug; defaults to workspace default
};
export type EmbeddingsResponse = {
  embeddings: number[][];
  model: string;
  usage: { tokens_in: number; tokens_out: 0 };
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatRequest = {
  messages: ChatMessage[];
  model?: string;
  provider?: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
};

export type VectorSearchRequest = {
  vector?: number[];
  query?: string;                 // if set, server embeds first, then searches
  k?: number;                     // default 10, max 100
  filter?: Record<string, unknown>; // JSON filter applied via jsonb metadata @>
  distance?: "cosine" | "l2" | "ip";
};
export type VectorSearchHit = {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  distance: number;
};

export type AiUsageRow = {
  id: number;
  provider_slug: string;
  model: string;
  endpoint: AiEndpoint;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  status_code: number;
  cost_usd_micro: number;
  created_at: string;
  actor_id: string | null;
};

/**
 * Vector-search targets are restricted to an allow-list so users can't
 * point the search at arbitrary tables. Configured via
 * `PLUTO_AI_VECTOR_ALLOW` (comma-separated) or per-workspace settings.
 */
export const DEFAULT_VECTOR_ALLOW = ["ai_embeddings_demo"] as const;
