import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Trash2, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { pluto, type PlutoUser } from "@/lib/pluto/client";
import { isLive, live, type AdminUser } from "@/lib/pluto/live";

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
  created_at: string;
};

function toLogical(u: AdminUser | PlutoUser): LogicalRole {
  const isSuper = "is_superadmin" in u ? Boolean((u as AdminUser).is_superadmin) : false;
  if (isSuper) return "super_admin";
  return u.role === "admin" ? "admin" : "user";
}

function UsersPage() {
  const [users, setUsers] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    setErr(null);
    try {
      if (isLive()) {
        const rows = await live.admin.users.list();
        setUsers(rows.map((r) => ({
          id: r.id,
          email: r.email,
          logical_role: toLogical(r),
          is_superadmin: Boolean(r.is_superadmin),
          email_verified: r.email_verified ?? false,
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
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { refresh(); }, []);

  async function setRole(id: string, role: LogicalRole) {
    setBusy(id); setErr(null);
    try {
      if (isLive()) {
        await live.admin.users.update(id, { role });
      } else {
        // Fallback for the demo client — collapses super_admin to admin.
        await pluto.users.setRole(id, role === "user" ? "user" : "admin");
      }
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function remove(id: string, email: string) {
    if (!confirm(`Delete user ${email}? This cannot be undone.`)) return;
    setBusy(id); setErr(null);
    try {
      if (isLive()) await live.admin.users.remove(id);
      else await pluto.users.remove(id);
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  return (
    <div>
      <PageHeader
        title="Auth & Users"
        description="Sign-up, email verification, এবং role management (super_admin / admin / user)।"
      />
      {err && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Request failed</div>
            <div className="text-xs opacity-90">{err}</div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Email</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Role</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Verified</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-border">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span>{u.email}</span>
                    {u.is_superadmin && (
                      <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                        SUPER
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <select
                    value={u.logical_role}
                    disabled={busy === u.id}
                    onChange={(e) => setRole(u.id, e.target.value as LogicalRole)}
                    className="rounded-md border border-input bg-background px-2 py-1 text-xs disabled:opacity-50"
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                    <option value="super_admin">super_admin</option>
                  </select>
                </td>
                <td className="px-4 py-2.5">
                  <span className={"inline-flex items-center rounded-full px-2 py-0.5 text-[11px] " + (u.email_verified ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600")}>
                    {u.email_verified ? "verified" : "pending"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{new Date(u.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => remove(u.id, u.email)}
                    disabled={busy === u.id}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                    title="Delete user"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-muted-foreground">No users yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">
        <strong>Role model:</strong> <code>super_admin</code> = full backend access (bypasses RLS, can manage all workspaces).
        <code className="ml-1">admin</code> = workspace-level administrative rights.
        <code className="ml-1">user</code> = regular authenticated user.
        Role changes take effect on the user's next request.
      </p>
    </div>
  );
}
