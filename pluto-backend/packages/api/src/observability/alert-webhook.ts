/**
 * Alert webhook dispatch.
 *
 * When `recordFailureWithSample()` returns a SpikeAlert, the central error
 * handler in server.ts also calls `dispatchAlert()` here. We fan out to
 * every enabled row in `admin.alert_webhooks` whose `tag_filter` matches
 * (empty filter = catch-all), fire-and-forget, with a 5s timeout each.
 *
 * Deep-link URLs point at the dashboard trace viewer when
 * PLUTO_DASHBOARD_URL is configured; otherwise they fall back to the API
 * paths (which the trace viewer resolves anyway).
 */
import { createHmac } from 'crypto';
import type { Config } from '../config.js';
import { getSql } from '../db/pool.js';
import type { SpikeAlert } from './alert-sink.js';

const TIMEOUT_MS = 5_000;

type WebhookRow = {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  tag_filter: string[];
  enabled: boolean;
};

function dashboardBase(): string | null {
  const raw = process.env.PLUTO_DASHBOARD_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function buildLinks(alert: SpikeAlert): { lookupUrlTemplate: string; listUrl: string } {
  const base = dashboardBase();
  if (!base) return { lookupUrlTemplate: alert.lookupUrlTemplate, listUrl: alert.listUrl };
  const tagRaw = alert.tag.replace(/^5xx:/, '');
  // Deep-link into the dashboard trace viewer with pre-filled filters.
  const list = new URL(`${base}/dashboard/traces`);
  if (alert.tag.startsWith('5xx:')) {
    list.searchParams.set('minStatus', '500');
    list.searchParams.set('maxStatus', '599');
  }
  if (tagRaw && tagRaw !== alert.tag) list.searchParams.set('tag', tagRaw);
  if (alert.tag === 'validation_failed') list.searchParams.set('errorCode', 'validation_failed');
  return {
    lookupUrlTemplate: `${base}/dashboard/traces?traceId={traceId}`,
    listUrl: list.toString(),
  };
}

export function enrichAlertLinks(alert: SpikeAlert): SpikeAlert {
  const { lookupUrlTemplate, listUrl } = buildLinks(alert);
  return { ...alert, lookupUrlTemplate, listUrl };
}

async function loadHooks(cfg: Config, tag: string): Promise<WebhookRow[]> {
  try {
    const sql = getSql(cfg);
    const rows = await sql<WebhookRow[]>`
      SELECT id, name, url, secret, tag_filter, enabled
        FROM admin.alert_webhooks
       WHERE enabled = true
         AND (cardinality(tag_filter) = 0 OR ${tag} = ANY(tag_filter))
    `;
    return rows;
  } catch {
    return [];
  }
}

async function markResult(cfg: Config, id: string, ok: boolean, status: number | null, error: string | null): Promise<void> {
  try {
    const sql = getSql(cfg);
    if (ok) {
      await sql`UPDATE admin.alert_webhooks
                   SET failure_count = 0, last_delivery_at = now(),
                       last_status = ${status}, last_error = null
                 WHERE id = ${id}`;
    } else {
      await sql`UPDATE admin.alert_webhooks
                   SET failure_count = failure_count + 1,
                       last_delivery_at = now(),
                       last_status = ${status},
                       last_error = ${error}
                 WHERE id = ${id}`;
    }
  } catch { /* observability must not crash the caller */ }
}

export async function sendOne(cfg: Config, hook: WebhookRow, payload: object): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'pluto-alert-webhook/1',
  };
  if (hook.secret) {
    const sig = createHmac('sha256', hook.secret).update(body).digest('hex');
    headers['x-pluto-signature'] = `sha256=${sig}`;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(hook.url, { method: 'POST', headers, body, signal: ac.signal });
    const ok = r.ok;
    await markResult(cfg, hook.id, ok, r.status, ok ? null : `HTTP ${r.status}`);
    return { ok, status: r.status, error: ok ? null : `HTTP ${r.status}` };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await markResult(cfg, hook.id, false, null, msg);
    return { ok: false, status: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget dispatch. Never throws.
 */
export function dispatchAlert(cfg: Config, alert: SpikeAlert): void {
  setImmediate(() => {
    void (async () => {
      try {
        const enriched = enrichAlertLinks(alert);
        const hooks = await loadHooks(cfg, alert.tag);
        if (!hooks.length) return;
        const payload = {
          type: 'pluto.alert.spike',
          alert: true,
          at: new Date().toISOString(),
          ...enriched,
        };
        await Promise.all(hooks.map((h) => sendOne(cfg, h, payload)));
      } catch { /* silent */ }
    })();
  });
}
