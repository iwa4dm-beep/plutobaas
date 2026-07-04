import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/pluto/PageHeader";
import { live } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/rbac")({
  head: () => ({
    meta: [
      { title: "Team & RBAC — Pluto" },
      { name: "description", content: "Manage workspace members, roles, and access scopes." },
    ],
  }),
  component: RbacPage,
});

type Member = { user_id: string; email: string; role: "owner" | "admin" | "developer" | "viewer" };

const ROLES = ["owner", "admin", "developer", "viewer"] as const;

function RbacPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [invite, setInvite] = useState("");
  const [role, setRole] = useState<Member["role"]>("developer");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const r = (await live.fetch("/admin/v1/workspaces/current/members")) as { members: Member[] };
      setMembers(r.members ?? []);
    } catch (e) { setErr((e as Error).message); }
  };
  useEffect(() => { void refresh(); }, []);

  const doInvite = async () => {
    setBusy(true); setErr(null);
    try {
      await live.fetch("/admin/v1/workspaces/current/members", {
        method: "POST", body: JSON.stringify({ email: invite, role }),
      });
      setInvite(""); await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const setMemberRole = async (uid: string, next: Member["role"]) => {
    setBusy(true);
    try {
      await live.fetch(`/admin/v1/workspaces/current/members/${uid}`, {
        method: "PATCH", body: JSON.stringify({ role: next }),
      });
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const remove = async (uid: string) => {
    if (!confirm("Remove this member from the workspace?")) return;
    setBusy(true);
    try {
      await live.fetch(`/admin/v1/workspaces/current/members/${uid}`, { method: "DELETE" });
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Team & access" description="Invite members and set their workspace role." />
      {err && <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm">{err}</div>}

      <div className="rounded-lg border p-4 space-y-3">
        <div className="font-medium">Invite a member</div>
        <div className="flex flex-wrap gap-2">
          <Input placeholder="email@example.com" value={invite}
                 onChange={(e) => setInvite(e.target.value)} className="max-w-sm" />
          <select value={role} onChange={(e) => setRole(e.target.value as Member["role"])}
                  className="h-9 rounded border bg-background px-3 text-sm">
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <Button onClick={doInvite} disabled={busy || !invite}>Send invite</Button>
        </div>
      </div>

      <div className="rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr><th className="text-left p-3">Email</th><th className="text-left p-3">Role</th><th /></tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id} className="border-t">
                <td className="p-3 font-mono">{m.email}</td>
                <td className="p-3">
                  <select value={m.role} disabled={m.role === "owner" || busy}
                          onChange={(e) => setMemberRole(m.user_id, e.target.value as Member["role"])}
                          className="h-8 rounded border bg-background px-2 text-sm">
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="p-3 text-right">
                  {m.role !== "owner" && (
                    <Button variant="ghost" size="sm" onClick={() => remove(m.user_id)}>Remove</Button>
                  )}
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr><td colSpan={3} className="p-6 text-center text-muted-foreground">No members yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">Role capabilities</div>
        <ul className="list-disc pl-5 space-y-1">
          <li><span className="font-mono">owner</span> — full control, billing, delete workspace</li>
          <li><span className="font-mono">admin</span> — invite members, rotate keys, all data operations</li>
          <li><span className="font-mono">developer</span> — schema + data + functions, no billing</li>
          <li><span className="font-mono">viewer</span> — read-only across all surfaces</li>
        </ul>
      </div>
    </div>
  );
}
