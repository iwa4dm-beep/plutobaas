// Hybrid Logical Clock — monotone across wall-clock skew, providing a
// total order of events keyed by (ts, ctr, actor). Used by the presence
// CRDT and the offline queue sequencer.
//
// The clock is a plain value; instances hold local state via `createHlc`.

export type Hlc = { ts: number; ctr: number; actor: string };

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.ctr !== b.ctr) return a.ctr - b.ctr;
  return a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0;
}

export function createHlc(actor: string, now: () => number = Date.now) {
  let state: Hlc = { ts: 0, ctr: 0, actor };
  return {
    now(): Hlc {
      const wall = now();
      if (wall > state.ts) state = { ts: wall, ctr: 0, actor };
      else state = { ts: state.ts, ctr: state.ctr + 1, actor };
      return { ...state };
    },
    observe(remote: Hlc): Hlc {
      const wall = now();
      const maxTs = Math.max(wall, state.ts, remote.ts);
      let ctr: number;
      if (maxTs === state.ts && maxTs === remote.ts) ctr = Math.max(state.ctr, remote.ctr) + 1;
      else if (maxTs === state.ts) ctr = state.ctr + 1;
      else if (maxTs === remote.ts) ctr = remote.ctr + 1;
      else ctr = 0;
      state = { ts: maxTs, ctr, actor };
      return { ...state };
    },
    peek(): Hlc { return { ...state }; },
  };
}
