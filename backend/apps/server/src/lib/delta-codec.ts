// Delta codec for realtime payloads.
//
// Given a per-topic baseline snapshot, encode changed keys as a small
// JSON Patch-ish envelope. Decoders apply the patch to their locally
// cached baseline to reconstruct the full payload. When no baseline
// exists, the encoder falls back to a full snapshot.
//
// The encoding is deliberately simple (object diff at the top level,
// value replacement below) to keep both encode and decode O(keys).

import { createHash } from "crypto";

export type DeltaOp =
  | { op: "set"; path: string; value: unknown }
  | { op: "del"; path: string };

export type DeltaEnvelope = {
  base_hash: string | null;
  full?: unknown;         // present when no baseline is available
  ops?: DeltaOp[];        // present when encoded as a delta
};

export function hashPayload(v: unknown): string {
  return createHash("sha256").update(canonical(v)).digest("hex").slice(0, 16);
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
}

export function encodeDelta(baseline: unknown | null, next: unknown): DeltaEnvelope {
  if (!isPlainObject(baseline) || !isPlainObject(next)) {
    return { base_hash: null, full: next };
  }
  const ops: DeltaOp[] = [];
  const b = baseline as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  for (const k of Object.keys(n)) {
    if (canonical(b[k]) !== canonical(n[k])) ops.push({ op: "set", path: k, value: n[k] });
  }
  for (const k of Object.keys(b)) {
    if (!(k in n)) ops.push({ op: "del", path: k });
  }
  return { base_hash: hashPayload(baseline), ops };
}

export function decodeDelta(baseline: unknown | null, env: DeltaEnvelope): unknown {
  if (env.full !== undefined) return env.full;
  if (!isPlainObject(baseline)) throw new Error("delta_baseline_missing");
  const out = { ...(baseline as Record<string, unknown>) };
  for (const op of env.ops ?? []) {
    if (op.op === "set") out[op.path] = op.value;
    else delete out[op.path];
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
