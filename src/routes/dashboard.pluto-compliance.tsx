import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory } from "@/lib/pluto/upstream";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/pluto-compliance")({
  component: CompliancePage,
  head: () => ({ meta: [{ title: "Pluto Compliance (GDPR/PII/DSAR)" }] }),
});

function CompliancePage() {
  const [projectId, setProjectId] = useState("");
  const [pii, setPii] = useState<any[]>([]);
  const [dsar, setDsar] = useState<any[]>([]);
  const [ret, setRet] = useState<any[]>([]);
  const [seals, setSeals] = useState<any[]>([]);
  const [newPii, setNewPii] = useState({ schema_name: "public", table_name: "", column_name: "", category: "email", masking: "none" });
  const [newDsar, setNewDsar] = useState({ subject_user_id: "", kind: "export", notes: "" });
  const [newRet, setNewRet] = useState({ schema_name: "public", table_name: "", ts_column: "created_at", keep_days: 365, strategy: "delete", enabled: true });
  const [scanSchema, setScanSchema] = useState("public");
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    if (!projectId) return;
    try {
      setPii(await plutoApi(`/admin/v1/pii/columns?project_id=${projectId}`));
      setDsar(await plutoApi(`/admin/v1/dsar?project_id=${projectId}`));
      setRet(await plutoApi(`/admin/v1/retention?project_id=${projectId}`));
      setSeals(await plutoApi(`/admin/v1/audit-seals?project_id=${projectId}`));
      setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  async function tagPii() { try { await plutoApi("/admin/v1/pii/columns", { method: "POST", body: JSON.stringify({ project_id: projectId, ...newPii }) }); pushUiHistory({ action: "pii.tag", detail: `${newPii.table_name}.${newPii.column_name}`, ok: true }); await refresh(); } catch (e: any) { setErr(e.message); } }
  async function scan() { try { const r = await plutoApi<any>("/admin/v1/pii/scan", { method: "POST", body: JSON.stringify({ project_id: projectId, schemas: [scanSchema] }) }); alert(`Scanned ${r.scanned}, tagged ${r.candidates}`); await refresh(); } catch (e: any) { setErr(e.message); } }
  async function createDsar() { try { await plutoApi("/admin/v1/dsar", { method: "POST", body: JSON.stringify({ project_id: projectId, ...newDsar }) }); pushUiHistory({ action: `dsar.${newDsar.kind}`, detail: newDsar.subject_user_id, ok: true }); await refresh(); } catch (e: any) { setErr(e.message); } }
  async function runDsar(id: string) { try { const r = await plutoApi<any>(`/admin/v1/dsar/${id}/run`, { method: "POST" }); alert(`Touched ${r.touched} rows${r.path ? " (bundle " + r.path + ")" : ""}`); await refresh(); } catch (e: any) { setErr(e.message); } }
  async function createRet() { try { await plutoApi("/admin/v1/retention", { method: "POST", body: JSON.stringify({ project_id: projectId, ...newRet, keep_days: Number(newRet.keep_days) }) }); await refresh(); } catch (e: any) { setErr(e.message); } }
  async function runRet(id: string) { try { const r = await plutoApi<any>(`/admin/v1/retention/${id}/run`, { method: "POST" }); alert(`Affected ${r.rows} rows`); await refresh(); } catch (e: any) { setErr(e.message); } }
  async function seal() { try { const r = await plutoApi<any>("/admin/v1/audit-seals", { method: "POST", body: JSON.stringify({ project_id: projectId }) }); alert(`Sealed ${r.row_count ?? 0} rows`); await refresh(); } catch (e: any) { setErr(e.message); } }
  async function verify() { try { const r = await plutoApi<any>("/admin/v1/audit-seals/verify"); alert(`${r.seals} seals · ${r.issues?.length ?? 0} issues${r.issues?.length ? "\n" + JSON.stringify(r.issues, null, 2) : ""}`); } catch (e: any) { setErr(e.message); } }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Compliance — PII, DSAR, Retention, Audit sealing</h1>
      <AutoHelpPanel slug={'dashboard.pluto-compliance'} title={'Compliance — PII, DSAR, Retention, Audit sealing'} description={''} />
      {err && <div className="rounded-md bg-destructive/10 text-destructive p-3 text-sm">{err}</div>}
      <input className="border rounded px-2 py-1 bg-background w-full" placeholder="Project ID" value={projectId} onChange={(e) => setProjectId(e.target.value)} />

      <section className="rounded-md border border-border p-4 space-y-2">
        <div className="flex justify-between items-center"><h2 className="font-medium">PII columns</h2>
          <div className="flex gap-2"><input className="border rounded px-2 py-1 bg-background text-sm" value={scanSchema} onChange={(e) => setScanSchema(e.target.value)} /><button className="border rounded px-3 py-1 text-sm" onClick={scan}>Auto-scan</button></div>
        </div>
        <div className="grid grid-cols-5 gap-2">
          <input className="border rounded px-2 py-1 bg-background" placeholder="schema" value={newPii.schema_name} onChange={(e) => setNewPii({ ...newPii, schema_name: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" placeholder="table" value={newPii.table_name} onChange={(e) => setNewPii({ ...newPii, table_name: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" placeholder="column" value={newPii.column_name} onChange={(e) => setNewPii({ ...newPii, column_name: e.target.value })} />
          <select className="border rounded px-2 py-1 bg-background" value={newPii.category} onChange={(e) => setNewPii({ ...newPii, category: e.target.value })}>
            {["email", "phone", "name", "address", "id_number", "financial", "health", "ip", "biometric", "other"].map((c) => <option key={c}>{c}</option>)}
          </select>
          <select className="border rounded px-2 py-1 bg-background" value={newPii.masking} onChange={(e) => setNewPii({ ...newPii, masking: e.target.value })}>
            {["none", "hash", "partial", "full"].map((m) => <option key={m}>{m}</option>)}
          </select>
        </div>
        <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={tagPii}>Tag column</button>
        <ul className="text-xs font-mono max-h-48 overflow-auto">
          {pii.map((p) => (<li key={p.id}>{p.schema_name}.{p.table_name}.{p.column_name} · {p.category} · mask={p.masking} · {p.detected_by}</li>))}
        </ul>
      </section>

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Data Subject Access Requests (DSAR)</h2>
        <div className="flex flex-wrap gap-2">
          <input className="border rounded px-2 py-1 bg-background" placeholder="subject user_id" value={newDsar.subject_user_id} onChange={(e) => setNewDsar({ ...newDsar, subject_user_id: e.target.value })} />
          <select className="border rounded px-2 py-1 bg-background" value={newDsar.kind} onChange={(e) => setNewDsar({ ...newDsar, kind: e.target.value })}>
            <option value="export">export</option><option value="erasure">erasure</option>
          </select>
          <input className="border rounded px-2 py-1 bg-background flex-1" placeholder="notes" value={newDsar.notes} onChange={(e) => setNewDsar({ ...newDsar, notes: e.target.value })} />
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={createDsar}>Create</button>
        </div>
        <ul className="text-sm space-y-1">
          {dsar.map((d) => (
            <li key={d.id} className="flex justify-between">
              <span>{d.kind} · {d.subject_user_id} · {d.status} · {new Date(d.requested_at).toLocaleString()}{d.bundle_path && ` · ${d.bundle_path}`}</span>
              {d.status === "pending" && <button className="underline" onClick={() => runDsar(d.id)}>Run</button>}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Retention policies</h2>
        <div className="grid grid-cols-6 gap-2">
          <input className="border rounded px-2 py-1 bg-background" placeholder="schema" value={newRet.schema_name} onChange={(e) => setNewRet({ ...newRet, schema_name: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" placeholder="table" value={newRet.table_name} onChange={(e) => setNewRet({ ...newRet, table_name: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" placeholder="ts column" value={newRet.ts_column} onChange={(e) => setNewRet({ ...newRet, ts_column: e.target.value })} />
          <input className="border rounded px-2 py-1 bg-background" type="number" placeholder="keep days" value={newRet.keep_days} onChange={(e) => setNewRet({ ...newRet, keep_days: Number(e.target.value) })} />
          <select className="border rounded px-2 py-1 bg-background" value={newRet.strategy} onChange={(e) => setNewRet({ ...newRet, strategy: e.target.value })}>
            <option>delete</option><option>anonymize</option>
          </select>
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={createRet}>Save</button>
        </div>
        <ul className="text-sm space-y-1">
          {ret.map((r) => (
            <li key={r.id} className="flex justify-between">
              <span>{r.schema_name}.{r.table_name} · keep {r.keep_days}d · {r.strategy}{!r.enabled && " (disabled)"} · last {r.last_run_at ? `${new Date(r.last_run_at).toLocaleDateString()} (${r.rows_last_run})` : "—"}</span>
              <button className="underline" onClick={() => runRet(r.id)}>Run</button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-md border border-border p-4 space-y-2">
        <h2 className="font-medium">Immutable audit sealing</h2>
        <div className="flex gap-2">
          <button className="bg-primary text-primary-foreground rounded px-3 py-1" onClick={seal}>Seal new</button>
          <button className="border rounded px-3 py-1" onClick={verify}>Verify chain</button>
        </div>
        <ul className="text-xs font-mono max-h-48 overflow-auto">
          {seals.map((s) => (<li key={s.id}>#{s.id} · {s.from_id}–{s.to_id} · {s.row_count} rows · {s.chain_hash.slice(0, 16)}… · {new Date(s.sealed_at).toLocaleString()}</li>))}
        </ul>
      </section>
    </div>
  );
}
