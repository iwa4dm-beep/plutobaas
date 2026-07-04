// Phase 41 — Auth hooks dispatcher.
//
// Fires configured webhooks for auth lifecycle events. `before_*` hooks
// are evaluated synchronously and MAY veto the action by returning
// { allow: false, reason: "..." } — the caller returns 403 in that case.
// `after_*` hooks are fire-and-forget: recorded to `auth_hook_deliveries`
// for audit, never block the response.

import { createHmac } from "node:crypto";
import { pgraw } from "./pgraw.js";

export type AuthHookEvent =
  | "before_signin"  | "after_signin"
  | "before_signup"  | "after_signup"
  | "before_password_reset" | "after_password_reset"
  | "after_magic_link"      | "after_anonymous_signin";

interface HookRow {
  id: string; event: AuthHookEvent; target_url: string;
  secret: string | null; timeout_ms: number;
}

async function activeHooks(event: AuthHookEvent): Promise<HookRow[]> {
  try {
    const r = await pgraw<HookRow>(
      `select id, event, target_url, secret, timeout_ms
         from public.auth_hooks
        where active and event = $1`,
      [event],
    );
    return r.rows;
  } catch {
    // Table may not exist during initial migration bootstrap.
    return [];
  }
}

async function record(hook_id: string, event: AuthHookEvent, status: number, ok: boolean,
                      duration_ms: number, error: string | null, body: unknown, respBody: string) {
  try {
    await pgraw(
      `insert into public.auth_hook_deliveries
         (hook_id, event, status, ok, duration_ms, error, request_body, response_body)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [hook_id, event, status, ok, duration_ms, error, JSON.stringify(body), respBody.slice(0, 8_000)],
    );
  } catch { /* audit best-effort */ }
}

async function fire(hook: HookRow, event: AuthHookEvent, payload: Record<string, unknown>) {
  const body = JSON.stringify({ event, ...payload, ts: new Date().toISOString() });
  const sig = hook.secret ? createHmac("sha256", hook.secret).update(body).digest("hex") : "";
  const started = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), hook.timeout_ms);
  try {
    const res = await fetch(hook.target_url, {
      method: "POST", signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-pluto-event": event,
        ...(sig ? { "x-pluto-signature": `sha256=${sig}` } : {}),
      },
      body,
    });
    const txt = await res.text().catch(() => "");
    await record(hook.id, event, res.status, res.ok, Date.now() - started, res.ok ? null : txt.slice(0, 500),
                 payload, txt);
    return { ok: res.ok, status: res.status, body: txt };
  } catch (e) {
    await record(hook.id, event, 0, false, Date.now() - started, (e as Error).message, payload, "");
    return { ok: false, status: 0, body: "" };
  } finally { clearTimeout(to); }
}

/** Fires every `before_*` hook synchronously; first veto wins. */
export async function dispatchBefore(event: AuthHookEvent, payload: Record<string, unknown>)
  : Promise<{ allow: true } | { allow: false; reason: string }> {
  const hooks = await activeHooks(event);
  for (const h of hooks) {
    const r = await fire(h, event, payload);
    if (!r.ok) return { allow: false, reason: "hook_rejected" };
    try {
      const parsed = JSON.parse(r.body || "{}");
      if (parsed && parsed.allow === false) {
        return { allow: false, reason: String(parsed.reason ?? "vetoed") };
      }
    } catch { /* non-JSON = allow */ }
  }
  return { allow: true };
}

/** Fire-and-forget every `after_*` hook. Never throws. */
export function dispatchAfter(event: AuthHookEvent, payload: Record<string, unknown>): void {
  void (async () => {
    const hooks = await activeHooks(event);
    for (const h of hooks) await fire(h, event, payload);
  })();
}
