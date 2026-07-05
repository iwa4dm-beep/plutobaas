import { EventEmitter } from 'node:events';
import pg from 'pg';
import type { Config } from '../config.js';

/**
 * Realtime hub — single Postgres LISTEN client fans out to all subscribers.
 * Also supports ad-hoc broadcast + presence channels held in-process.
 */
export type PostgresChangePayload = {
  schema: string;
  table: string;
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  record: Record<string, any> | null;
  old: Record<string, any> | null;
  ts: number;
};

export type BroadcastMsg = {
  channel: string;
  event: string;
  payload: any;
  sender?: string;
};

class RealtimeHub extends EventEmitter {
  private pgClient: pg.Client | null = null;
  private ready = false;
  // channel -> Set of member ids (for presence)
  presence = new Map<string, Map<string, any>>();

  async start(cfg: Config): Promise<void> {
    if (this.ready) return;
    const client = new pg.Client({ connectionString: cfg.DATABASE_URL });
    client.on('error', (e) => console.error('[realtime] pg error', e.message));
    client.on('notification', (msg) => {
      if (msg.channel !== 'pluto_realtime' || !msg.payload) return;
      try {
        const p = JSON.parse(msg.payload) as PostgresChangePayload;
        this.emit('postgres_changes', p);
      } catch (e: any) {
        console.warn('[realtime] bad payload', e.message);
      }
    });
    await client.connect();
    await client.query('LISTEN pluto_realtime');
    this.pgClient = client;
    this.ready = true;
  }

  async stop(): Promise<void> {
    if (this.pgClient) {
      try { await this.pgClient.end(); } catch {}
      this.pgClient = null;
    }
    this.ready = false;
    this.removeAllListeners();
    this.presence.clear();
  }

  broadcast(msg: BroadcastMsg) {
    this.emit(`broadcast:${msg.channel}`, msg);
  }

  presenceJoin(channel: string, id: string, state: any) {
    if (!this.presence.has(channel)) this.presence.set(channel, new Map());
    this.presence.get(channel)!.set(id, state);
    this.emit(`presence:${channel}`, { event: 'join', id, state, snapshot: this.presenceSnapshot(channel) });
  }

  presenceLeave(channel: string, id: string) {
    const map = this.presence.get(channel);
    if (!map) return;
    const state = map.get(id);
    map.delete(id);
    if (map.size === 0) this.presence.delete(channel);
    this.emit(`presence:${channel}`, { event: 'leave', id, state, snapshot: this.presenceSnapshot(channel) });
  }

  presenceSnapshot(channel: string): Record<string, any> {
    const map = this.presence.get(channel);
    if (!map) return {};
    return Object.fromEntries(map.entries());
  }
}

let _hub: RealtimeHub | null = null;
export function getHub(): RealtimeHub {
  if (!_hub) _hub = new RealtimeHub();
  return _hub;
}
