import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { pluto, type PlutoUser } from "@/lib/pluto/client";
import { isLive, live, type AdminUser } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/users")({
  component: UsersPage,
});

type Row = PlutoUser | (AdminUser & { email_verified: boolean; created_at: string });

function UsersPage() {
  const [users, setUsers] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setErr(null);
    try {
      if (isLive()) {
        const rows = await live.admin.users.list();
        setUsers(rows.map((r) => ({ ...r, email_verified: r.email_verified ?? false })));
      } else {
        setUsers(await pluto.users.list());
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => { refresh(); }, []);

  async function setRole(id: string, role: "admin" | "user") {
    if (isLive()) await live.admin.users.update(id, { role });
    else await pluto.users.setRole(id, role);
    refresh();
  }
  async function remove(id: string) {
    if (isLive()) await live.admin.users.remove(id);
    else await pluto.users.remove(id);
    refresh();
  }

  return (
    <div>
      <PageHeader
        title="Auth & Users"
        description="Sign-up, email verification, এবং role management।"
      />
      {err && <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{err}</div>}


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
                <td className="px-4 py-2.5">{u.email}</td>
                <td className="px-4 py-2.5">
                  <select
                    value={u.role}
                    onChange={(e) => setRole(u.id, e.target.value as "admin" | "user")}
                    className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td className="px-4 py-2.5">
                  <span className={"inline-flex items-center rounded-full px-2 py-0.5 text-[11px] " + (u.email_verified ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600")}>
                    {u.email_verified ? "verified" : "pending"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{new Date(u.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => remove(u.id)} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
