// Phase 57 — SCIM v2 provisioning store.
//
// In-memory implementation of the subset of SCIM 2.0 (RFC 7643/7644) that
// enterprise IdPs use for user/group lifecycle: Users, Groups, PATCH ops,
// filtering by userName / externalId, and soft de-provision via `active=false`.
// The plugin adapts this to Fastify routes; tests drive it directly.

import { randomUUID } from "node:crypto";

export type ScimUser = {
  id: string;
  externalId?: string;
  userName: string;
  displayName?: string;
  active: boolean;
  emails?: { value: string; primary?: boolean }[];
  workspace_id: string;
  meta: { resourceType: "User"; created: string; lastModified: string };
};

export type ScimGroup = {
  id: string;
  externalId?: string;
  displayName: string;
  members: { value: string }[];       // user ids
  workspace_id: string;
  meta: { resourceType: "Group"; created: string; lastModified: string };
};

const users  = new Map<string, ScimUser>();      // id → user
const groups = new Map<string, ScimGroup>();     // id → group

function iso() { return new Date().toISOString(); }

// ---------- Users -------------------------------------------------------
export function createUser(ws: string, body: Partial<ScimUser>): ScimUser {
  if (!body.userName) throw new Error("userName_required");
  // Uniqueness per (workspace, userName).
  for (const u of users.values()) {
    if (u.workspace_id === ws && u.userName === body.userName) throw new Error("user_exists");
  }
  const now = iso();
  const u: ScimUser = {
    id: randomUUID(),
    externalId: body.externalId,
    userName:   body.userName,
    displayName: body.displayName,
    active:     body.active ?? true,
    emails:     body.emails ?? [],
    workspace_id: ws,
    meta: { resourceType: "User", created: now, lastModified: now },
  };
  users.set(u.id, u);
  return u;
}

export function getUser(ws: string, id: string): ScimUser | undefined {
  const u = users.get(id);
  return u && u.workspace_id === ws ? u : undefined;
}

export function listUsers(ws: string, filter?: { userName?: string; externalId?: string; startIndex?: number; count?: number }) {
  let all = [...users.values()].filter((u) => u.workspace_id === ws);
  if (filter?.userName)   all = all.filter((u) => u.userName === filter.userName);
  if (filter?.externalId) all = all.filter((u) => u.externalId === filter.externalId);
  const startIndex = Math.max(1, filter?.startIndex ?? 1);
  const count      = Math.max(0, filter?.count ?? all.length);
  const page       = all.slice(startIndex - 1, startIndex - 1 + count);
  return { totalResults: all.length, startIndex, itemsPerPage: page.length, Resources: page };
}

export function replaceUser(ws: string, id: string, body: Partial<ScimUser>): ScimUser {
  const u = getUser(ws, id); if (!u) throw new Error("not_found");
  Object.assign(u, {
    externalId: body.externalId ?? u.externalId,
    userName:   body.userName ?? u.userName,
    displayName: body.displayName ?? u.displayName,
    active:     body.active ?? u.active,
    emails:     body.emails ?? u.emails,
  });
  u.meta.lastModified = iso();
  return u;
}

export type ScimPatchOp = { op: "add" | "replace" | "remove"; path?: string; value?: unknown };

export function patchUser(ws: string, id: string, ops: ScimPatchOp[]): ScimUser {
  const u = getUser(ws, id); if (!u) throw new Error("not_found");
  for (const op of ops) {
    const path = (op.path ?? "").toLowerCase();
    if (op.op === "replace" && path === "active") u.active = Boolean(op.value);
    else if (op.op === "replace" && path === "displayname") u.displayName = String(op.value ?? "");
    else if (op.op === "replace" && !path && typeof op.value === "object" && op.value) {
      Object.assign(u, op.value as Partial<ScimUser>);
    } else if (op.op === "remove" && path === "active") u.active = false;
    else if (op.op === "add" && path === "emails" && Array.isArray(op.value)) {
      u.emails = [...(u.emails ?? []), ...(op.value as ScimUser["emails"] ?? [])];
    } else {
      throw new Error(`unsupported_patch:${op.op}:${path}`);
    }
  }
  u.meta.lastModified = iso();
  return u;
}

export function deleteUser(ws: string, id: string): boolean {
  const u = getUser(ws, id); if (!u) return false;
  users.delete(id);
  // Cascade: remove from group members.
  for (const g of groups.values()) {
    if (g.workspace_id !== ws) continue;
    const before = g.members.length;
    g.members = g.members.filter((m) => m.value !== id);
    if (g.members.length !== before) g.meta.lastModified = iso();
  }
  return true;
}

// ---------- Groups ------------------------------------------------------
export function createGroup(ws: string, body: Partial<ScimGroup>): ScimGroup {
  if (!body.displayName) throw new Error("displayName_required");
  const now = iso();
  const g: ScimGroup = {
    id: randomUUID(),
    externalId: body.externalId,
    displayName: body.displayName,
    members: body.members ?? [],
    workspace_id: ws,
    meta: { resourceType: "Group", created: now, lastModified: now },
  };
  groups.set(g.id, g);
  return g;
}
export function getGroup(ws: string, id: string): ScimGroup | undefined {
  const g = groups.get(id); return g && g.workspace_id === ws ? g : undefined;
}
export function listGroups(ws: string) {
  const all = [...groups.values()].filter((g) => g.workspace_id === ws);
  return { totalResults: all.length, startIndex: 1, itemsPerPage: all.length, Resources: all };
}
export function patchGroup(ws: string, id: string, ops: ScimPatchOp[]): ScimGroup {
  const g = getGroup(ws, id); if (!g) throw new Error("not_found");
  for (const op of ops) {
    const path = (op.path ?? "").toLowerCase();
    if (op.op === "add" && path === "members" && Array.isArray(op.value)) {
      const add = (op.value as { value: string }[]).filter((m) => !g.members.some((x) => x.value === m.value));
      g.members.push(...add);
    } else if (op.op === "remove" && path.startsWith("members")) {
      const m = path.match(/value eq \"([^\"]+)\"/);
      if (m) g.members = g.members.filter((x) => x.value !== m[1]);
      else g.members = [];
    } else if (op.op === "replace" && path === "displayname") {
      g.displayName = String(op.value ?? "");
    } else {
      throw new Error(`unsupported_patch:${op.op}:${path}`);
    }
  }
  g.meta.lastModified = iso();
  return g;
}
export function deleteGroup(ws: string, id: string): boolean {
  const g = getGroup(ws, id); if (!g) return false;
  return groups.delete(id);
}

export function _resetScimForTests() { users.clear(); groups.clear(); }
