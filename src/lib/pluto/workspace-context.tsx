// Active-workspace context.
//
// The dashboard often needs to say "run this action in the context of
// workspace X" — SQL runner history, REST endpoints browser, storage
// buckets, etc. This provider resolves the list of workspaces the
// current admin has access to, remembers the selection in localStorage,
// and exposes helpers so pages can:
//
//   * read the active workspace (id + slug + role)
//   * switch to a different one
//   * guard membership before navigation (isMember() → boolean)
//
// If the backend isn't configured or the caller isn't an admin, we
// fall back to a single synthetic "root" workspace so the UI keeps
// rendering without erroring out.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isLive, live, type Workspace } from "@/lib/pluto/live";

const STORAGE_KEY = "pluto.active_workspace.v1";

const ROOT: Workspace = {
  id: "00000000-0000-0000-0000-000000000001",
  slug: "root",
  name: "Root workspace",
  created_at: new Date(0).toISOString(),
  archived_at: null,
  member_count: 0,
  active_keys: 0,
};

type Ctx = {
  workspaces: Workspace[];
  active: Workspace;
  loading: boolean;
  error: string | null;
  setActive: (id: string) => void;
  refresh: () => Promise<void>;
  isMember: (workspaceId?: string) => boolean;
};

const WorkspaceContext = createContext<Ctx | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([ROOT]);
  const [activeId, setActiveId] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) ?? ROOT.id; }
    catch { return ROOT.id; }
  });
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isLive()) { setWorkspaces([ROOT]); return; }
    setLoading(true); setError(null);
    try {
      const { workspaces: list } = await live.workspaces.list();
      const items = list.length > 0 ? list : [ROOT];
      setWorkspaces(items);
      // If our stored active id disappeared, snap to the first one.
      if (!items.some((w) => w.id === activeId)) {
        setActiveId(items[0].id);
      }
    } catch (e) {
      // Non-admins get 403 — degrade gracefully.
      setError(e instanceof Error ? e.message : String(e));
      setWorkspaces([ROOT]);
    } finally {
      setLoading(false);
    }
  }, [activeId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setActive = useCallback((id: string) => {
    setActiveId(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* private mode */ }
  }, []);

  const active = useMemo<Workspace>(
    () => workspaces.find((w) => w.id === activeId) ?? workspaces[0] ?? ROOT,
    [workspaces, activeId]
  );

  const isMember = useCallback(
    (workspaceId?: string) => {
      const id = workspaceId ?? active.id;
      // Root workspace is always "member" for env-key holders.
      if (id === ROOT.id) return true;
      const w = workspaces.find((x) => x.id === id);
      // If we listed workspaces successfully the row's presence in the
      // list implies membership (the admin API filters to the caller's
      // own memberships when not env-service).
      return !!w;
    },
    [workspaces, active.id]
  );

  return (
    <WorkspaceContext.Provider value={{ workspaces, active, loading, error, setActive, refresh, isMember }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): Ctx {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return v;
}
