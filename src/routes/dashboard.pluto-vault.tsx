import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/pluto-vault")({
  component: VaultPage,
  head: () => ({ meta: [{ title: "Pluto Vault & Secrets" }] }),
});

function VaultPage() {
  const [projectId, setProjectId] = useState("");
  const [env, setEnv] = useState("production");
  const [secrets, setSecrets] = useState<any[]>([]);
  const [keys, setKeys] = useState<any[]>([]);
  const [log, setLog] = useState<any[]>([]);
  const [dyn, setDyn] = useState<any[]>([]);
  const [newSec, setNewSec] = useState({ name: "", value: "", description: "" });
  const [rotate, setRotate] = useState<{ id: string; value: string } | null>(null);
  const [ttl, setTtl] = useState(60);
  const [reveal, setReveal] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!projectId) return;
    try {
      setSecrets(await plutoApi(`/admin/v1/vault/secrets?project_id=${projectId}&environment=${env}`));
      setKeys(await plutoApi(`/admin/v1/vault/keys?project_id=${projectId}`));
      setLog(await plutoApi(`/admin/v1/vault/access-log?project_id=${projectId}`));
      setDyn(await plutoApi(`/admin/v1/vault/db-credentials?project_id=${projectId}`));
      setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId, env]);

  async function create() {
    try {
      await plutoApi("/admin/v1/vault/secrets", { method: "POST", body: JSON.stringify({ project_id: projectId, environment: env, ...newSec }) });
      pushUiHistory({ action: "vault.write", detail: newSec.name, ok: true });
      setNewSec({ name: "", value: "", description: "" });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function doReveal(id: string) {
    try { setReveal(await plutoApi(`/admin/v1/vault/secrets/${id}/reveal`, { method: "POST", body: "{}" })); } catch (e: any) { setErr(e.message); }
  }
  async function doRotate() {
    if (!rotate) return;
    try {
      await plutoApi(`/admin/v1/vault/secrets/${rotate.id}/rotate`, { method: "POST", body: JSON.stringify({ value: rotate.value }) });
      setRotate(null); await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function rotateKey() {
    try { const r = await plutoApi<any>("/admin/v1/vault/keys/rotate", { method: "POST", body: JSON.stringify({ project_id: projectId, alias: "default" }) }); alert(`Rewrapped ${r.rewrapped} secrets`); await refresh(); } catch (e: any) { setErr(e.message); }
  }
  async function issueDyn() {
    try { const r = await plutoApi<any>("/admin/v1/vault/db-credentials", { method: "POST", body: JSON.stringify({ project_id: projectId, ttl_minutes: Number(ttl) }) }); alert(`Username: ${r.username}\nPassword: ${r.password}`); await refresh(); } catch (e: any) { setErr(e.message); }
  }
  async function revokeDyn(id: string) {
    try { await plutoApi(`/admin/v1/vault/db-credentials/${id}/revoke`, { method: "POST" }); await refresh(); } catch (e: any) { setErr(e.message); }
  }
  async function del(id: string) {
    if (!confirm("Delete secret + all versions?")) return;
    try { await plutoApi(`/admin/v1/vault/secrets/${id}`, { method: "DELETE" }); await refresh(); } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Vault & Secrets</h1>
      <AutoHelpPanel slug={'dashboard.pluto-vault'} title={'Vault & Secrets'} description={''} />
        <p className="text-sm text-muted-foreground">KMS-style envelope encryption, versioning, rotation, audit trail, dynamic DB credentials.</p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <input className="border rounded px-3 py-2 text-sm w-80" placeholder="project_id (uuid)" value={projectId} onChange={(e) => setProjectId(e.target.value)} />
        <select className="border rounded px-3 py-2 text-sm" value={env} onChange={(e) => setEnv(e.target.value)}>
          <option value="development">development</option>
          <option value="staging">staging</option>
          <option value="production">production</option>
        </select>
        <button className="px-3 py-2 text-sm rounded bg-primary text-primary-foreground" onClick={refresh}>Refresh</button>
        <button className="px-3 py-2 text-sm rounded border" onClick={rotateKey}>Rotate KEK (rewrap all)</button>
      </div>
      {err && <div className="text-sm text-destructive">{err}</div>}

      <section className="border rounded-lg p-4 space-y-3">
        <h2 className="font-medium">Create / update secret</h2>
        <div className="flex flex-wrap gap-2">
          <input className="border rounded px-3 py-2 text-sm" placeholder="NAME" value={newSec.name} onChange={(e) => setNewSec({ ...newSec, name: e.target.value })} />
          <input className="border rounded px-3 py-2 text-sm flex-1 min-w-64" placeholder="value" value={newSec.value} onChange={(e) => setNewSec({ ...newSec, value: e.target.value })} />
          <input className="border rounded px-3 py-2 text-sm" placeholder="description" value={newSec.description} onChange={(e) => setNewSec({ ...newSec, description: e.target.value })} />
          <button className="px-3 py-2 text-sm rounded bg-primary text-primary-foreground" onClick={create}>Save (creates new version)</button>
        </div>
      </section>

      <section className="border rounded-lg p-4 space-y-2">
        <h2 className="font-medium">Secrets ({env})</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground"><tr><th>Name</th><th>Version</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            {secrets.map((s) => (
              <tr key={s.id} className="border-t">
                <td className="py-2">{s.name}</td>
                <td>v{s.current_version}</td>
                <td>{new Date(s.updated_at).toLocaleString()}</td>
                <td className="text-right space-x-2">
                  <button className="underline" onClick={() => doReveal(s.id)}>Reveal</button>
                  <button className="underline" onClick={() => setRotate({ id: s.id, value: "" })}>Rotate</button>
                  <button className="underline text-destructive" onClick={() => del(s.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rotate && (
          <div className="flex gap-2 mt-2">
            <input className="border rounded px-3 py-2 text-sm flex-1" placeholder="new value" value={rotate.value} onChange={(e) => setRotate({ ...rotate, value: e.target.value })} />
            <button className="px-3 py-2 text-sm rounded bg-primary text-primary-foreground" onClick={doRotate}>Rotate now</button>
            <button className="px-3 py-2 text-sm rounded border" onClick={() => setRotate(null)}>Cancel</button>
          </div>
        )}
        {reveal && (
          <div className="mt-2 p-3 bg-muted rounded text-xs font-mono break-all">
            {reveal.name} (v{reveal.version}) = <b>{reveal.value}</b>
            <button className="ml-3 underline" onClick={() => setReveal(null)}>Hide</button>
          </div>
        )}
      </section>

      <section className="border rounded-lg p-4 space-y-2">
        <h2 className="font-medium">Dynamic DB credentials</h2>
        <div className="flex gap-2">
          <input className="border rounded px-3 py-2 text-sm w-32" type="number" value={ttl} onChange={(e) => setTtl(Number(e.target.value))} />
          <span className="self-center text-sm text-muted-foreground">minutes</span>
          <button className="px-3 py-2 text-sm rounded bg-primary text-primary-foreground" onClick={issueDyn}>Issue new credential</button>
        </div>
        <table className="w-full text-sm mt-2">
          <thead className="text-left text-muted-foreground"><tr><th>Username</th><th>Expires</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {dyn.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="py-2 font-mono text-xs">{d.username}</td>
                <td>{new Date(d.expires_at).toLocaleString()}</td>
                <td>{d.revoked_at ? "revoked" : "active"}</td>
                <td className="text-right">{!d.revoked_at && <button className="underline text-destructive" onClick={() => revokeDyn(d.id)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="border rounded-lg p-4">
        <h2 className="font-medium mb-2">Keys</h2>
        <ul className="text-sm space-y-1">
          {keys.map((k) => <li key={k.id} className="font-mono text-xs">{k.alias} · {k.algo} · kek={k.kek_id} · rotated={k.rotated_at ?? "never"}</li>)}
        </ul>
      </section>

      <section className="border rounded-lg p-4">
        <h2 className="font-medium mb-2">Access log (last 100)</h2>
        <ul className="text-xs font-mono space-y-1 max-h-64 overflow-auto">
          {log.map((l) => <li key={l.id}>{new Date(l.at).toISOString()} · {l.action} · {l.name}@{l.environment} v{l.version ?? "-"}</li>)}
        </ul>
      </section>
    </div>
  );
}
