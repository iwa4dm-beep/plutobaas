import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Lock, Plus, RotateCw, Save, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";
import { isLive, live } from "@/lib/pluto/live";
import { previewSubdomainUrl } from "@/lib/pluto/reserved-slugs";

export const Route = createFileRoute("/dashboard/projects/$slug/env")({
  component: ProjectEnvPage,
});

// Contract with the Pluto backend (Phase C endpoints — implement in
// pluto-backend/packages/api/src/routes/admin/projects/*.ts). The dashboard
// calls these via the service-role admin surface on live.ts.
type EnvRow = { key: string; value: string; updated_at?: string };
type SecretMeta = { name: string; hint?: string | null; created_at: string; rotated_at?: string | null };

function ProjectEnvPage() {
  const { slug } = Route.useParams();
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newSecretName, setNewSecretName] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
  const [revealed, setRevealed] = useState<{ name: string; plaintext: string } | null>(null);

  const admin = useMemo(
    () => (live as unknown as { admin: { projectEnv?: { list: (s: string) => Promise<{ items: EnvRow[] }>; set: (s: string, k: string, v: string) => Promise<void>; remove: (s: string, k: string) => Promise<void> }; projectSecrets?: { list: (s: string) => Promise<{ items: SecretMeta[] }>; create: (s: string, n: string, v: string) => Promise<{ name: string; plaintext: string }>; rotate: (s: string, n: string) => Promise<{ name: string; plaintext: string }>; remove: (s: string, n: string) => Promise<void> } } }).admin,
    [],
  );

  const load = useCallback(async () => {
    if (!isLive()) return;
    setErr(null);
    try {
      const [{ items: e }, { items: s }] = await Promise.all([
        admin.projectEnv?.list(slug) ?? Promise.resolve({ items: [] as EnvRow[] }),
        admin.projectSecrets?.list(slug) ?? Promise.resolve({ items: [] as SecretMeta[] }),
      ]);
      setEnvRows(e);
      setSecrets(s);
    } catch (e) { setErr(e); }
  }, [slug, admin]);

  useEffect(() => { void load(); }, [load]);

  async function saveEnv(key: string, value: string) {
    setErr(null);
    try { await admin.projectEnv?.set(slug, key, value); await load(); }
    catch (e) { setErr(e); }
  }
  async function removeEnv(key: string) {
    if (!confirm(`Delete env var ${key}?`)) return;
    setErr(null);
    try { await admin.projectEnv?.remove(slug, key); await load(); }
    catch (e) { setErr(e); }
  }
  async function addEnv() {
    if (!newKey.trim() || !newValue.trim()) return;
    await saveEnv(newKey.trim().toUpperCase(), newValue);
    setNewKey(""); setNewValue("");
  }
  async function addSecret() {
    if (!newSecretName.trim() || !newSecretValue.trim() || !admin.projectSecrets) return;
    setErr(null);
    try {
      const r = await admin.projectSecrets.create(slug, newSecretName.trim().toUpperCase(), newSecretValue);
      setRevealed(r);
      setNewSecretName(""); setNewSecretValue("");
      await load();
    } catch (e) { setErr(e); }
  }
  async function rotateSecret(name: string) {
    if (!admin.projectSecrets) return;
    setErr(null);
    try {
      const r = await admin.projectSecrets.rotate(slug, name);
      setRevealed(r);
      await load();
    } catch (e) { setErr(e); }
  }
  async function removeSecret(name: string) {
    if (!confirm(`Delete secret ${name}? Deployed functions will lose access immediately.`)) return;
    setErr(null);
    try { await admin.projectSecrets?.remove(slug, name); await load(); }
    catch (e) { setErr(e); }
  }

  return (
    <div className="mx-auto max-w-5xl p-4">
      <PageHeader
        title={`Env & Secrets — ${slug}`}
        subtitle={<>Live site: <a className="font-mono underline" href={previewSubdomainUrl(slug)} target="_blank" rel="noreferrer">{previewSubdomainUrl(slug)}</a></>}
      />
      <ErrorBanner error={err} onRetry={() => void load()} onDismiss={() => setErr(null)} />

      {/* -------- Public runtime env -------- */}
      <div className="mb-6 rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-medium">Public runtime env</h2>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          এখানে যা লেখা আছে সব <code className="font-mono">/env.js</code>-এ ইনজেক্ট হয়ে <code className="font-mono">window.__PLUTO_ENV__</code>-এ পৌঁছায় — ব্রাউজারে দৃশ্যমান। কখনো <b>service_role</b> বা secret এখানে রাখবেন না; সেগুলোর জন্য নিচের Secret Vault ব্যবহার করুন।
        </p>
        <div className="flex flex-wrap gap-2">
          <input placeholder="KEY_NAME" value={newKey}
            onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            className="min-w-40 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm" />
          <input placeholder="value" value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            className="min-w-56 flex-[2] rounded-md border border-input bg-background px-3 py-2 text-sm" />
          <button onClick={addEnv} disabled={!newKey || !newValue}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        <div className="mt-4 overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40"><tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Key</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Value</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Actions</th>
            </tr></thead>
            <tbody>
              {envRows.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-center text-xs text-muted-foreground">No runtime env vars yet.</td></tr>}
              {envRows.map((r) => (
                <tr key={r.key} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">{r.key}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.value}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => removeEnv(r.key)} className="inline-flex items-center gap-1 text-xs text-destructive hover:underline">
                      <Trash2 className="h-3 w-3" /> Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* -------- Server-only secrets -------- */}
      <div className="mb-6 rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-medium">Secret vault (server-only)</h2>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Encrypted at rest (AES-256-GCM), শুধু edge functions / server routes-এ decrypt হয়। Plaintext একবারই দেখানো হয় — নিচে save করার পর।
        </p>

        {revealed && (
          <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
            <div className="text-sm font-medium">Secret "{revealed.name}" — একবারই দেখানো হচ্ছে</div>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 truncate rounded border border-border bg-background px-2 py-1 font-mono text-xs">{revealed.plaintext}</code>
              <button onClick={() => { navigator.clipboard.writeText(revealed.plaintext); }}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs">Copy</button>
              <button onClick={() => setRevealed(null)}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs">Hide</button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <input placeholder="SECRET_NAME" value={newSecretName}
            onChange={(e) => setNewSecretName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            className="min-w-40 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm" />
          <input placeholder="secret value" value={newSecretValue} type="password"
            onChange={(e) => setNewSecretValue(e.target.value)}
            className="min-w-56 flex-[2] rounded-md border border-input bg-background px-3 py-2 text-sm" />
          <button onClick={addSecret} disabled={!newSecretName || !newSecretValue}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Save className="h-3.5 w-3.5" /> Save
          </button>
        </div>

        <div className="mt-4 overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40"><tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Name</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Hint</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Rotated</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Actions</th>
            </tr></thead>
            <tbody>
              {secrets.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-center text-xs text-muted-foreground">No secrets yet.</td></tr>}
              {secrets.map((s) => (
                <tr key={s.name} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">{s.name}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{s.hint ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{s.rotated_at ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => rotateSecret(s.name)} className="mr-2 inline-flex items-center gap-1 text-xs hover:underline">
                      <RotateCw className="h-3 w-3" /> Rotate
                    </button>
                    <button onClick={() => removeSecret(s.name)} className="inline-flex items-center gap-1 text-xs text-destructive hover:underline">
                      <Trash2 className="h-3 w-3" /> Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
