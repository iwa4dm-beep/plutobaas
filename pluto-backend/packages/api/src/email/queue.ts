// Phase 16 · Email queue worker.
// Polls admin.email_queue every POLL_MS and dispatches pending rows via
// the shared SMTP transport in ./mailer.ts. Retries up to MAX_ATTEMPTS
// with exponential backoff; permanently marks as 'failed' after that.

import type { Config } from '../config.js';
import { getSql } from '../db/pool.js';
import { sendMail } from './mailer.js';

const POLL_MS = 10_000;
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 5;

let running = false;

async function tick(cfg: Config): Promise<void> {
  const sql = getSql(cfg);
  // Claim a batch atomically — SELECT ... FOR UPDATE SKIP LOCKED prevents
  // two workers from sending the same row (safe if you scale API replicas).
  const rows: any[] = await sql`
    with claimed as (
      select id from admin.email_queue
      where status in ('pending','failed')
        and scheduled_at <= now()
        and attempts < ${MAX_ATTEMPTS}
      order by scheduled_at asc
      limit ${BATCH_SIZE}
      for update skip locked
    )
    update admin.email_queue q
       set status = 'sending', attempts = attempts + 1
      from claimed
     where q.id = claimed.id
    returning q.id, q.to_email, q.subject, q.html, q.template, q.attempts
  `;
  for (const r of rows) {
    const res = await sendMail(cfg, r.to_email, r.subject, r.html, r.template);
    if (res.ok) {
      await sql`
        update admin.email_queue
        set status = 'sent', sent_at = now(), last_error = null
        where id = ${r.id}`;
    } else if (r.attempts >= MAX_ATTEMPTS) {
      await sql`
        update admin.email_queue
        set status = 'failed', last_error = ${res.error ?? 'unknown'}
        where id = ${r.id}`;
    } else {
      // Exponential backoff — 30s, 2m, 8m, 32m...
      const delay = 30 * Math.pow(4, r.attempts - 1);
      await sql`
        update admin.email_queue
        set status = 'pending',
            last_error = ${res.error ?? 'unknown'},
            scheduled_at = now() + (${delay} || ' seconds')::interval
        where id = ${r.id}`;
    }
  }
}

export function startEmailWorker(cfg: Config, log: { info: Function; error: Function }): void {
  if (running) return;
  running = true;
  log.info(`[email-worker] starting — poll every ${POLL_MS}ms`);
  const loop = async () => {
    try { await tick(cfg); } catch (e: any) { log.error(`[email-worker] tick failed: ${e.message}`); }
    setTimeout(loop, POLL_MS);
  };
  setTimeout(loop, POLL_MS);
}
