import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/pluto-orgs")({
  component: OrgsPage,
  head: () => ({ meta: [{ title: "Pluto Organizations & Teams" }] }),
});

function OrgsPage() {
  const [orgs, setOrgs] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [members, setMembers] = useState<any[]>([]);
  const [invites, setInvites] = useState<any[]>([]);
  const [form, setForm] = useState({ slug: "", name: "", billing_email: "" });
  const [inv, setInv] = useState({ email: "", role: "developer" });
  const [projectId, setProjectId] = useState("");
  const [keys, setKeys] = useState<any[]>([]);
  const [newKey, setNewKey] = useState({ name: "", scopes: ["read"] as string[] });
  const [lastSecret, setLastSecret] = useState<string | null>(null);

  async function refresh() {
    try { setOrgs(await plutoApi("/admin/v1/orgs")); setErr(null); }
    catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!selected) return;
    void (async () => {
      try {
        setMembers(await plutoApi(`/admin/v1/orgs/${selected}/members`));
        setInvites(await plutoApi(`/admin/v1/orgs/${selected}/invites`));
      } catch (e: any) { setErr(e.message); }
    })();
  }, [selected]);
  useEffect(() => {
    if (!projectId) return;
    void (async () => {
      try { setKeys(await plutoApi(`/admin/v1/projects/${projectId}/api-keys`)); }
      catch (e: any) { setErr(e.message); }
    })();
  }, [projectId]);

  async function createOrg() {
    try {
      await plutoApi("/admin/v1/orgs", { method: "POST", body: JSON.stringify(form) });
      pushUiHistory({ action: "org.create", detail: form.slug, ok: true });
      setForm({ slug: "", name: "", billing_email: "" });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function invite() {
    try {
      await plutoApi("/admin/v1/orgs/invites", { method: "POST", body: JSON.stringify({ org_id: selected, ...inv }) });
      pushUiHistory({ action: "org.invite", detail: inv.email, ok: true });
      setInv({ email: "", role: "developer" });
      setInvites(await plutoApi(`/admin/v1/orgs/${selected}/invites`));
    } catch (e: any) { setErr(e.message); }
  }
  async function removeMember(userId: string) {
    if (!confirm("Remove this member?")) return;
    try {
      await plutoApi(`/admin/v1/orgs/${selected}/members/${userId}`, { method: "DELETE" });
      setMembers(await plutoApi(`/admin/v1/orgs/${selected}/members`));
    } catch (e: any) { setErr(e.message); }
  }
  async function createKey() {
    try {
      const r = await plutoApi<any>("/admin/v1/projects/api-keys", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId, name: newKey.name, scopes: newKey.scopes }),
      });
      setLastSecret(r.secret);
      pushUiHistory({ action: "api_key.create", detail: newKey.name, ok: true });
      setNewKey({ name: "", scopes: ["read"] });
      setKeys(await plutoApi(`/admin/v1/projects/${projectId}/api-keys`));
    } catch (e: any) { setErr(e.message); }
  }
  async function revokeKey(id: string) {
    if (!confirm("Revoke this API key?")) return;
    try {
      await plutoApi(`/admin/v1/projects/api-keys/${id}`, { method: "DELETE" });
      setKeys(await plutoApi(`/admin/v1/projects/${projectId}/api-keys`));
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Organizations & Teams</h1>
      <AutoHelpPanel slug={'dashboard.pluto-orgs'} title={'Organizations & Teams'} description={''} />
        <p className="text-sm text-muted-foreground">Manage orgs, members, invites, and project API keys.</p>
      </div>
      {err && <div className="rounded-md bg-destructive/10 text-destructive p-3 text-sm">{err}</div>}

      <section className="rounded-md border border-border p-4">
        <h2 className="font-medium mb-3">Create organization</h2>
        <div className="flex gap-2 flex-wrap">
          <input className="border rounded px-2 py-1 bg-background" placeholder="slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" placeholder="Billing email" value={form.billing_email} onChange={(e) => setForm({ ...form, billing_email: e.target.value })} />
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={createOrg}>Create</button>
        </div>
      </section>

      <section className="rounded-md border border-border p-4">
        <h2 className="font-medium mb-3">Your organizations</h2>
        <ul className="space-y-1">
          {orgs.map((o) => (
            <li key={o.id} className="flex justify-between items-center">
              <button className={`text-left ${selected === o.id ? "font-semibold" : ""}`} onClick={() => setSelected(o.id)}>
                {o.name} <span className="text-xs text-muted-foreground">@{o.slug} · {o.my_role}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {selected && (
        <section className="rounded-md border border-border p-4 space-y-4">
          <h2 className="font-medium">Members</h2>
          <ul className="text-sm space-y-1">
            {members.map((m) => (
              <li key={m.id} className="flex justify-between">
                <span>{m.email ?? m.user_id} — {m.role}</span>
                <button className="text-destructive text-xs" onClick={() => removeMember(m.user_id)}>Remove</button>
              </li>
            ))}
          </ul>
          <h2 className="font-medium">Invite</h2>
          <div className="flex gap-2 flex-wrap">
            <input className="border rounded px-2 py-1 bg-background" placeholder="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
            <select className="border rounded px-2 py-1 bg-background" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>
              <option>owner</option><option>admin</option><option>developer</option><option>viewer</option>
            </select>
            <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={invite}>Send invite</button>
          </div>
          <ul className="text-xs text-muted-foreground space-y-1">
            {invites.map((i) => (
              <li key={i.id}>{i.email} — {i.role} — {i.accepted_at ? "accepted" : `expires ${new Date(i.expires_at).toLocaleDateString()}`}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-md border border-border p-4 space-y-3">
        <h2 className="font-medium">Project API keys</h2>
        <input className="border rounded px-2 py-1 bg-background w-full" placeholder="Project ID (uuid)" value={projectId} onChange={(e) => setProjectId(e.target.value)} />
        {projectId && (
          <>
            <div className="flex gap-2 flex-wrap items-center">
              <input className="border rounded px-2 py-1 bg-background" placeholder="Key name" value={newKey.name} onChange={(e) => setNewKey({ ...newKey, name: e.target.value })} />
              {(["read", "write", "admin"] as const).map((s) => (
                <label key={s} className="text-sm flex gap-1 items-center">
                  <input type="checkbox" checked={newKey.scopes.includes(s)} onChange={(e) => setNewKey({ ...newKey, scopes: e.target.checked ? [...newKey.scopes, s] : newKey.scopes.filter((x) => x !== s) })} />
                  {s}
                </label>
              ))}
              <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={createKey}>Create key</button>
            </div>
            {lastSecret && (
              <div className="rounded bg-yellow-500/10 border border-yellow-500/30 p-2 text-sm">
                Copy now — you won't see this again: <code className="font-mono">{lastSecret}</code>
              </div>
            )}
            <ul className="text-sm space-y-1">
              {keys.map((k) => (
                <li key={k.id} className="flex justify-between">
                  <span><code>{k.key_prefix}…</code> · {k.name} · {(k.scopes ?? []).join(",")} {k.revoked_at && <em className="text-destructive">(revoked)</em>}</span>
                  {!k.revoked_at && <button className="text-destructive text-xs" onClick={() => revokeKey(k.id)}>Revoke</button>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
