// Phase 60 — Presence sharding.
//
// Presence state is partitioned across N shards using a stable hash of
// (workspace, user_id). Each shard owns its member set so writes stay
// local and never cross-block. `whichShard()` is deterministic so any
// node can compute the owner without coordination.

import { createHash } from "crypto";

export type PresenceEntry = {
  workspace: string;
  room: string;
  user_id: string;
  status: "online" | "away" | "offline";
  meta?: Record<string, unknown>;
  updated_at: number;
};

const DEFAULT_SHARDS = Number(process.env.PLUTO_PRESENCE_SHARDS ?? "8");

class PresenceShard {
  members = new Map<string, PresenceEntry>(); // key: `${ws}::${room}::${user}`
}

const shards: PresenceShard[] = Array.from({ length: DEFAULT_SHARDS }, () => new PresenceShard());

export function shardCount() { return shards.length; }

export function whichShard(workspace: string, user_id: string): number {
  const h = createHash("sha1").update(`${workspace}\x00${user_id}`).digest();
  return h.readUInt32BE(0) % shards.length;
}

const key = (ws: string, room: string, user: string) => `${ws}::${room}::${user}`;

export function upsertPresence(e: Omit<PresenceEntry, "updated_at">): { shard: number; entry: PresenceEntry } {
  const shard = whichShard(e.workspace, e.user_id);
  const entry: PresenceEntry = { ...e, updated_at: Date.now() };
  shards[shard].members.set(key(e.workspace, e.room, e.user_id), entry);
  return { shard, entry };
}

export function removePresence(workspace: string, room: string, user_id: string): boolean {
  const shard = whichShard(workspace, user_id);
  return shards[shard].members.delete(key(workspace, room, user_id));
}

export function listRoom(workspace: string, room: string): PresenceEntry[] {
  const out: PresenceEntry[] = [];
  const prefix = `${workspace}::${room}::`;
  for (const s of shards) {
    for (const [k, v] of s.members) if (k.startsWith(prefix)) out.push(v);
  }
  return out;
}

export function shardStats(): { shard: number; size: number }[] {
  return shards.map((s, i) => ({ shard: i, size: s.members.size }));
}

export function _resetPresenceForTests() {
  for (const s of shards) s.members.clear();
}
