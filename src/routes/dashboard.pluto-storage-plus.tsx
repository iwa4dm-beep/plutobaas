import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/pluto-storage-plus")({
  component: StoragePlus,
  head: () => ({ meta: [{ title: "Pluto Storage v2" }] }),
});

function StoragePlus() {
  const [projectId, setProjectId] = useState("");
  const [bucket, setBucket] = useState("");
  const [policies, setPolicies] = useState<any[]>([]);
  const [transforms, setTransforms] = useState<any[]>([]);
  const [uploads, setUploads] = useState<any[]>([]);
  const [pol, setPol] = useState({ role: "authenticated", perms: ["read"] as string[], path_prefix: "" });
  const [tf, setTf] = useState({ name: "thumb", width: 320, height: 320, fit: "cover", format: "auto", quality: 80 });
  const [signed, setSigned] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!projectId) return;
    try {
      setPolicies(await plutoApi(`/storage/v1/policies?project_id=${projectId}${bucket ? `&bucket=${bucket}` : ""}`));
      setTransforms(await plutoApi(`/storage/v1/transforms?project_id=${projectId}${bucket ? `&bucket=${bucket}` : ""}`));
      setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId, bucket]);

  async function addPolicy() {
    try {
      await plutoApi("/storage/v1/policies", { method: "POST", body: JSON.stringify({ project_id: projectId, bucket, ...pol }) });
      pushUiHistory({ action: "storage.policy.upsert", detail: `${bucket}:${pol.role}`, ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function addTransform() {
    try {
      await plutoApi("/storage/v1/transforms", { method: "POST", body: JSON.stringify({ project_id: projectId, bucket, ...tf, width: Number(tf.width), height: Number(tf.height), quality: Number(tf.quality) }) });
      pushUiHistory({ action: "storage.transform.upsert", detail: `${bucket}:${tf.name}`, ok: true });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function signTransform(name: string) {
    const key = prompt("Object key to sign?");
    if (!key) return;
    try {
      const r = await plutoApi<any>("/storage/v1/transforms/sign", { method: "POST", body: JSON.stringify({ project_id: projectId, bucket, object_key: key, transform: name, ttl_seconds: 3600 }) });
      setSigned(r.url);
    } catch (e: any) { setErr(e.message); }
  }
  async function initResumable() {
    const key = prompt("Object key?");
    const size = Number(prompt("Total size in bytes?") ?? "0");
    if (!key || !size) return;
    try {
      const r = await plutoApi<any>("/storage/v1/resumable/init", { method: "POST", body: JSON.stringify({ project_id: projectId, bucket, object_key: key, size }) });
      setUploads([r, ...uploads]);
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Storage v2 (policies, resumable, transforms)</h1>
      <AutoHelpPanel slug={'dashboard.pluto-storage-plus'} title={'Storage v2 (policies, resumable, transforms)'} description={''} />
      {err && <div className="rounded-md bg-destructive/10 text-destructive p-3 text-sm">{err}</div>}
      <div className="flex gap-2">
        <input className="border rounded px-2 py-1 bg-background flex-1" placeholder="Project ID" value={projectId} onChange={(e) => setProjectId(e.target.value)} />
        <input className="border rounded px-2 py-1 bg-background" placeholder="bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} />
      </div>

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Role → perms policies</h2>
        <div className="flex gap-2 flex-wrap items-center">
          <select className="border rounded px-2 py-1 bg-background" value={pol.role} onChange={(e) => setPol({ ...pol, role: e.target.value })}>
            <option>anon</option><option>authenticated</option><option>service_role</option>
          </select>
          {["read", "write", "delete", "list"].map((p) => (
            <label key={p} className="text-sm flex gap-1 items-center">
              <input type="checkbox" checked={pol.perms.includes(p)} onChange={(e) => setPol({ ...pol, perms: e.target.checked ? [...pol.perms, p] : pol.perms.filter((x) => x !== p) })} />{p}
            </label>
          ))}
          <input className="border rounded px-2 py-1 bg-background" placeholder="path_prefix" value={pol.path_prefix} onChange={(e) => setPol({ ...pol, path_prefix: e.target.value })} />
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={addPolicy} disabled={!bucket}>Upsert</button>
        </div>
        <ul className="text-xs font-mono">
          {policies.map((p) => (<li key={p.id}>{p.bucket} · {p.role} · [{(p.perms ?? []).join(",")}] {p.path_prefix && `prefix=${p.path_prefix}`}</li>))}
        </ul>
      </section>

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Image transform presets</h2>
        <div className="flex gap-2 flex-wrap items-center">
          <input className="border rounded px-2 py-1 bg-background w-24" placeholder="name" value={tf.name} onChange={(e) => setTf({ ...tf, name: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background w-20" type="number" placeholder="w" value={tf.width} onChange={(e) => setTf({ ...tf, width: Number(e.target.value) })} />
          <input className="border rounded px-2 py-1 bg-background w-20" type="number" placeholder="h" value={tf.height} onChange={(e) => setTf({ ...tf, height: Number(e.target.value) })} />
          <select className="border rounded px-2 py-1 bg-background" value={tf.fit} onChange={(e) => setTf({ ...tf, fit: e.target.value })}>
            {["cover", "contain", "fill", "inside", "outside"].map((x) => <option key={x}>{x}</option>)}
          </select>
          <select className="border rounded px-2 py-1 bg-background" value={tf.format} onChange={(e) => setTf({ ...tf, format: e.target.value })}>
            {["auto", "jpeg", "webp", "avif", "png"].map((x) => <option key={x}>{x}</option>)}
          </select>
          <input className="border rounded px-2 py-1 bg-background w-20" type="number" placeholder="q" value={tf.quality} onChange={(e) => setTf({ ...tf, quality: Number(e.target.value) })} />
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={addTransform} disabled={!bucket}>Save preset</button>
        </div>
        <ul className="text-xs font-mono space-y-1">
          {transforms.map((t) => (
            <li key={t.id} className="flex justify-between">
              <span>{t.bucket}·{t.name} → {JSON.stringify(t.spec)}</span>
              <button className="underline" onClick={() => signTransform(t.name)}>Sign URL</button>
            </li>
          ))}
        </ul>
        {signed && <div className="text-xs bg-muted rounded p-2 break-all">Signed: <code>{signed}</code></div>}
      </section>

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Resumable uploads</h2>
        <button className="border rounded px-3 py-1" onClick={initResumable} disabled={!bucket}>Init upload</button>
        <ul className="text-xs font-mono">
          {uploads.map((u) => (<li key={u.upload_id}>{u.upload_id} · size {u.size} · received {u.received} · status {u.status}</li>))}
        </ul>
      </section>
    </div>
  );
}
