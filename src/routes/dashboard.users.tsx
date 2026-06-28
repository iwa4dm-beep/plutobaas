import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { pluto, type PlutoUser } from "@/lib/pluto/client";

export const Route = createFileRoute("/dashboard/users")({
  component: UsersPage,
});

function UsersPage() {
  const [users, setUsers] = useState<PlutoUser[]>([]);

  async function refresh() { setUsers(await pluto.users.list()); }
  useEffect(() => { refresh(); }, []);

  async function setRole(id: string, role: "admin" | "user") { await pluto.users.setRole(id, role); refresh(); }
  async function remove(id: string) { await pluto.users.remove(id); refresh(); }

  return (
    <div>
      <PageHeader title="Auth & Users" description="Sign-up, email verification, এবং role management।" />

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
