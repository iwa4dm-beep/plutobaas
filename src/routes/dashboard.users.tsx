import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, ShieldAlert, CheckCircle2, Clock, Search, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/pluto/PageHeader";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";
import { pluto, type PlutoUser } from "@/lib/pluto/client";
import { isLive, live, type AdminUser } from "@/lib/pluto/live";
import { useAuth } from "@/lib/pluto/auth-context";

export const Route = createFileRoute("/dashboard/users")({
  component: UsersPage,
});

type LogicalRole = "super_admin" | "admin" | "user";
type Row = {
  id: string;
  email: string;
  logical_role: LogicalRole;
  is_superadmin: boolean;
  email_verified: boolean;
  email_confirmed_at?: string | null;
  created_at: string;
};

type Filter = "all" | "pending" | "verified";

function toLogical(u: AdminUser | PlutoUser): LogicalRole {
  const isSuper = "is_superadmin" in u ? Boolean((u as AdminUser).is_superadmin) : false;
  if (isSuper) return "super_admin";
  return u.role === "admin" ? "admin" : "user";
}

function UsersPage() {
  const { session } = useAuth();
  const currentUserId = session?.user?.id ?? null;
  // Superadmin flag isn't in the AuthProvider session shape — read it from the live session store.
  const meIsSuperadmin = isLive() ? Boolean(live.auth.session()?.user?.is_superadmin) : false;

  const [users, setUsers] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const setRowBusy = (id: string, on: boolean) =>
    setBusy((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      if (isLive()) {
        const rows = await live.admin.users.list();
        setUsers(rows.map((r) => ({
          id: r.id,
          email: r.email,
          logical_role: toLogical(r),
          is_superadmin: Boolean(r.is_superadmin),
          email_verified: r.email_verified ?? Boolean(r.email_confirmed_at),
          email_confirmed_at: r.email_confirmed_at ?? null,
          created_at: r.created_at,
        })));
      } else {
        const rows = await pluto.users.list();
        setUsers(rows.map((r) => ({
          id: r.id,
          email: r.email,
          logical_role: toLogical(r),
          is_superadmin: false,
          email_verified: r.email_verified ?? false,
          created_at: r.created_at ?? new Date().toISOString(),
        })));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return users.filter((u) => {
      if (filter === "pending" && u.email_verified) return false;
      if (filter === "verified" && !u.email_verified) return false;
      if (term && !u.email.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [users, filter, q]);

  const pendingCount = useMemo(() => users.filter((u) => !u.email_verified).length, [users]);

  async function approve(id: string) {
    if (!isLive()) {
      toast.error("Demo mode: enable live backend to approve users.");
      return;
    }
    setRowBusy(id, true);
    // optimistic
    setUsers((s) => s.map((u) => u.id === id ? { ...u, email_verified: true } : u));
    try {
      await live.admin.users.update(id, { email_verified: true });
      toast.success("User verified");
    } catch (e) {
      setUsers((s) => s.map((u) => u.id === id ? { ...u, email_verified: false } : u));
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRowBusy(id, false);
    }
  }

  async function revokeVerify(id: string, email: string) {
    if (!confirm(`Revoke email verification for ${email}?`)) return;
    setRowBusy(id, true);
    setUsers((s) => s.map((u) => u.id === id ? { ...u, email_verified: false } : u));
    try {
      await live.admin.users.update(id, { email_verified: false });
      toast.success("Verification revoked");
    } catch (e) {
      setUsers((s) => s.map((u) => u.id === id ? { ...u, email_verified: true } : u));
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRowBusy(id, false);
    }
  }

  async function approveSelected() {
    const ids = Array.from(selected).filter((id) => {
      const u = users.find((x) => x.id === id);
      return u && !u.email_verified;
    });
    if (ids.length === 0) { toast("Nothing to approve"); return; }
    for (const id of ids) await approve(id);
    setSelected(new Set());
  }

  async function setRole(id: string, role: LogicalRole) {
    const target = users.find((u) => u.id === id);
    if (!target) return;
    if (role === "super_admin" && !confirm(`Grant full backend (super_admin) access to ${target.email}?`)) return;
    if (target.logical_role === "super_admin" && role !== "super_admin"
      && !confirm(`Remove super_admin from ${target.email}?`)) return;

    setRowBusy(id, true); setErr(null);
    try {
      if (isLive()) {
        await live.admin.users.update(id, { role });
      } else {
        await pluto.users.setRole(id, role === "user" ? "user" : "admin");
      }
      toast.success("Role updated");
      await refresh();
      // Self-demotion → sign out.
      if (id === currentUserId && role === "user") {
        toast("You demoted yourself — signing out.");
        setTimeout(() => { window.location.href = "/auth"; }, 800);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg); toast.error(msg);
    } finally {
      setRowBusy(id, false);
    }
  }

  async function remove(id: string, email: string) {
    if (!confirm(`Delete user ${email}? This cannot be undone.`)) return;
    setRowBusy(id, true); setErr(null);
    try {
      if (isLive()) await live.admin.users.remove(id);
      else await pluto.users.remove(id);
      toast.success("User deleted");
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg); toast.error(msg);
    } finally {
      setRowBusy(id, false);
    }
  }

  const allSelectedOnPage = filtered.length > 0 && filtered.every((u) => selected.has(u.id));
  function toggleAll() {
    setSelected((s) => {
      const n = new Set(s);
      if (allSelectedOnPage) filtered.forEach((u) => n.delete(u.id));
      else filtered.forEach((u) => n.add(u.id));
      return n;
    });
  }

  return (
    <div>
      <PageHeader
        title="Auth & Users"
        description="Sign-up, email verification, এবং role management (super_admin / admin / user)।"
      />
      <AutoHelpPanel slug={'dashboard.users'} title={'Auth & Users'} description={'Sign-up, email verification, এবং role management (super_admin / admin / user)।'} />

      {err && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Request failed</div>
            <div className="text-xs opacity-90">{err}</div>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border bg-card p-0.5 text-xs">
          {(["all", "pending", "verified"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={
                "px-3 py-1.5 rounded capitalize " +
                (filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")
              }
            >
              {f}
              {f === "pending" && pendingCount > 0 && (
                <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 text-[10px] text-amber-600">{pendingCount}</span>
              )}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search email…"
            className="w-64 rounded-md border border-input bg-background pl-7 pr-2 py-1.5 text-xs"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && (
            <button
              onClick={approveSelected}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Approve selected ({selected.size})
            </button>
          )}
          <button
            onClick={refresh}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-xs hover:bg-muted"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="w-8 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={allSelectedOnPage}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Email</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Role</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Status</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Created</th>
              <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => {
              const isMe = u.id === currentUserId;
              const rowBusy = busy.has(u.id);
              const canEditRole = meIsSuperadmin || (!u.is_superadmin && !isMe);
              const canDelete = !isMe && (meIsSuperadmin || !u.is_superadmin);
              return (
                <tr key={u.id} className="border-t border-border">
                  <td className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={selected.has(u.id)}
                      onChange={(e) => setSelected((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(u.id); else n.delete(u.id);
                        return n;
                      })}
                      aria-label={`Select ${u.email}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span>{u.email}</span>
                      {u.is_superadmin && (
                        <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                          SUPER
                        </span>
                      )}
                      {isMe && (
                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          you
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <select
                      value={u.logical_role}
                      disabled={rowBusy || !canEditRole}
                      onChange={(e) => setRole(u.id, e.target.value as LogicalRole)}
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs disabled:opacity-50"
                      title={!canEditRole ? "Only a super_admin can change this row" : undefined}
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                      {meIsSuperadmin && <option value="super_admin">super_admin</option>}
                    </select>
                  </td>
                  <td className="px-4 py-2.5">
                    {u.email_verified ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-600"
                        title={u.email_confirmed_at ? `Confirmed ${new Date(u.email_confirmed_at).toLocaleString()}` : "Verified"}
                      >
                        <CheckCircle2 className="h-3 w-3" /> verified
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">
                        <Clock className="h-3 w-3" /> pending
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      {!u.email_verified && (
                        <button
                          onClick={() => approve(u.id)}
                          disabled={rowBusy}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                          title="Manually mark email as verified"
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          Approve
                        </button>
                      )}
                      {u.email_verified && meIsSuperadmin && !isMe && (
                        <button
                          onClick={() => revokeVerify(u.id, u.email)}
                          disabled={rowBusy}
                          className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
                          title="Revoke verification"
                        >
                          <ShieldCheck className="h-3 w-3" />
                          Revoke
                        </button>
                      )}
                      <button
                        onClick={() => remove(u.id, u.email)}
                        disabled={rowBusy || !canDelete}
                        className="text-muted-foreground hover:text-destructive disabled:opacity-30"
                        title={!canDelete ? "Cannot delete this user" : "Delete user"}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-xs text-muted-foreground">
                  {users.length === 0
                    ? "No users yet."
                    : filter === "pending"
                      ? "No pending users — everyone is verified. 🎉"
                      : "No users match this filter."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">
        <strong>Role model:</strong> <code>super_admin</code> = full backend access (bypasses RLS, can manage all workspaces).
        <code className="ml-1">admin</code> = workspace-level administrative rights.
        <code className="ml-1">user</code> = regular authenticated user.
        Manual "Approve" marks a user's email as verified even if they never clicked the confirmation link.
      </p>
    </div>
  );
}
