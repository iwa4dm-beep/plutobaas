// Phase 57 — Session isolation policies + auth/audit event log.
//
// Sessions are bound to a (workspace_id, user_email) pair when minted.
// Any attempt to reuse a session on a different workspace is rejected and
// logged. Admin/tenant permission checks share the same audit stream so
// operators can see who did what and when.

import { randomUUID } from "node:crypto";

export type Session = {
  id: string;
  workspace_id: string;
  user_email: string;
  role: "admin" | "member";
  ip?: string;
  created_at: number;
  expires_at: number;
  revoked: boolean;
};

export type AuthEvent = {
  id: string;
  ts: number;
  workspace_id: string;
  user_email: string | null;
  action: string;              // e.g. "session.create", "session.reuse_denied", "admin.check"
  status: "ok" | "denied" | "error";
  meta?: Record<string, unknown>;
  trace_id?: string;           // Phase 58: correlate with distributed trace
};

const sessions = new Map<string, Session>();
const events: AuthEvent[] = [];
const MAX_EVENTS = 5000;

export function logAuth(e: Omit<AuthEvent, "id" | "ts">): AuthEvent {
  const ev: AuthEvent = { id: `ae_${randomUUID()}`, ts: Date.now(), ...e };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return ev;
}

export function listEvents(ws: string, limit = 100): AuthEvent[] {
  return events.filter((e) => e.workspace_id === ws).slice(-limit).reverse();
}

export function createSession(ws: string, user_email: string, role: "admin" | "member" = "member", ttl_ms = 60 * 60 * 1000, ip?: string): Session {
  const s: Session = {
    id: `sid_${randomUUID()}`,
    workspace_id: ws,
    user_email,
    role,
    ip,
    created_at: Date.now(),
    expires_at: Date.now() + ttl_ms,
    revoked: false,
  };
  sessions.set(s.id, s);
  logAuth({ workspace_id: ws, user_email, action: "session.create", status: "ok", meta: { role } });
  return s;
}

// The isolation policy: session must exist, not be revoked/expired, and
// its `workspace_id` must equal the requested workspace. Anything else is
// a denial event on the audit stream.
export function resolveSession(session_id: string, requested_ws: string): { ok: true; session: Session } | { ok: false; error: string } {
  const s = sessions.get(session_id);
  if (!s) {
    logAuth({ workspace_id: requested_ws, user_email: null, action: "session.resolve", status: "denied", meta: { reason: "unknown_session" } });
    return { ok: false, error: "unknown_session" };
  }
  if (s.revoked) {
    logAuth({ workspace_id: requested_ws, user_email: s.user_email, action: "session.resolve", status: "denied", meta: { reason: "revoked" } });
    return { ok: false, error: "revoked" };
  }
  if (Date.now() > s.expires_at) {
    logAuth({ workspace_id: requested_ws, user_email: s.user_email, action: "session.resolve", status: "denied", meta: { reason: "expired" } });
    return { ok: false, error: "expired" };
  }
  if (s.workspace_id !== requested_ws) {
    logAuth({ workspace_id: requested_ws, user_email: s.user_email, action: "session.reuse_denied", status: "denied",
             meta: { bound_workspace: s.workspace_id, requested_workspace: requested_ws } });
    return { ok: false, error: "wrong_workspace" };
  }
  return { ok: true, session: s };
}

export function revokeSession(id: string): boolean {
  const s = sessions.get(id); if (!s) return false;
  s.revoked = true;
  logAuth({ workspace_id: s.workspace_id, user_email: s.user_email, action: "session.revoke", status: "ok" });
  return true;
}

// Admin / tenant permission check. `requireAdmin` returns true and logs
// a denial event if the session isn't an admin in the tenant.
export function checkAdmin(session_id: string, requested_ws: string): { ok: boolean; error?: string; session?: Session } {
  const r = resolveSession(session_id, requested_ws);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.session.role !== "admin") {
    logAuth({ workspace_id: requested_ws, user_email: r.session.user_email, action: "admin.check", status: "denied", meta: { role: r.session.role } });
    return { ok: false, error: "not_admin", session: r.session };
  }
  logAuth({ workspace_id: requested_ws, user_email: r.session.user_email, action: "admin.check", status: "ok" });
  return { ok: true, session: r.session };
}

export function _resetSessionsForTests() { sessions.clear(); events.length = 0; }
