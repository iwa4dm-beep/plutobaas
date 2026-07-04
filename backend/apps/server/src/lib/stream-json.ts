// Phase 59 — Streaming JSON responder.
//
// Emits NDJSON (one JSON object per line) with an initial `meta` frame and
// a terminating `end` frame. Uses an async iterator source so producers
// can honor backpressure via `reply.raw.write() === false` → wait for
// `drain`. Consumers parse line-by-line without buffering the entire
// dataset in memory.

import type { FastifyReply } from "fastify";

export type StreamFrame =
  | { type: "meta"; total?: number; schema?: string }
  | { type: "row"; data: unknown }
  | { type: "end"; count: number; next_cursor?: string | null }
  | { type: "error"; message: string };

export async function streamNdjson<T>(
  reply: FastifyReply,
  source: AsyncIterable<T>,
  opts: { schema?: string; total?: number; extract_cursor?: (last: T, count: number) => string | null } = {},
): Promise<void> {
  reply.raw.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  reply.raw.setHeader("cache-control", "no-store");
  reply.raw.setHeader("transfer-encoding", "chunked");
  reply.hijack();

  const write = (frame: StreamFrame) =>
    new Promise<void>((resolve, reject) => {
      const line = JSON.stringify(frame) + "\n";
      const ok = reply.raw.write(line, "utf8");
      if (ok) return resolve();
      reply.raw.once("drain", resolve);
      reply.raw.once("error", reject);
    });

  let count = 0;
  let last: T | undefined;
  try {
    await write({ type: "meta", total: opts.total, schema: opts.schema });
    for await (const row of source) {
      await write({ type: "row", data: row });
      last = row;
      count++;
    }
    const next_cursor = last !== undefined && opts.extract_cursor ? opts.extract_cursor(last, count) : null;
    await write({ type: "end", count, next_cursor });
  } catch (e) {
    try { await write({ type: "error", message: (e as Error).message }); }
    catch { /* client already gone */ }
  } finally {
    reply.raw.end();
  }
}

// Helper: convert an array into an async iterable that yields in chunks
// (useful for tests and adapters that materialize results in memory).
export async function* chunked<T>(arr: T[], chunk = 100): AsyncGenerator<T> {
  for (let i = 0; i < arr.length; i++) {
    yield arr[i];
    if (i > 0 && i % chunk === 0) await new Promise((r) => setImmediate(r));
  }
}

// Parse an NDJSON body from a Fastify inject payload back into frames.
export function parseNdjson(body: string): StreamFrame[] {
  return body.split("\n").filter(Boolean).map((l) => JSON.parse(l) as StreamFrame);
}
