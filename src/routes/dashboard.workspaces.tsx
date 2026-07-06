import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Copy, KeyRound, Plus, ShieldCheck, Trash2, Users2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";
import { isLive, live, type Workspace, type WorkspaceKey, type WorkspaceMember } from "@/lib/pluto/live";


export const Route = createFileRoute("/dashboard/workspaces")({
  component: WorkspacesPage,
});

function WorkspacesPage() {
  const [items, setItems] = useState<Workspace[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [freshKeys, setFreshKeys] = useState<{ slug: string; anon: string; service_role: string } | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    if (!isLive()) { setItems([]); setErr("Backend not configured (VITE_PLUTO_URL / VITE_PLUTO_SERVICE_KEY)."); return; }
    try {
      const { workspaces } = await live.workspaces.list();
      setItems(workspaces);
      if (!active && workspaces[0]) setActive(workspaces[0].id);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [active]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <PageHeader
        title="Workspaces"
        description="Each workspace has its own users, API keys, and RLS-scoped data. The 'root' workspace is served by the env-configured keys."
      />

      {err && (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5" /> {err}
        </div>
      )}

      <div className="grid lg:grid-cols-[280px_1fr] gap-4">
        <aside className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">Tenants</span>
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Plus className="h-3.5 w-3.5" /> New
            </button>
          </div>
          <ul className="divide-y divide-border text-sm">
            {(items ?? []).map((w) => (
              <li key={w.id}>
                <button
                  onClick={() => setActive(w.id)}
                  className={"w-full text-left px-3 py-2 hover:bg-accent/60 " + (active === w.id ? "bg-accent/70" : "")}
                >
                  <div className="font-medium">{w.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {w.slug} · {w.member_count} members · {w.active_keys} keys
                  </div>
                </button>
              </li>
            ))}
            {items && items.length === 0 && (
              <li className="px-3 py-6 text-xs text-muted-foreground">No workspaces yet.</li>
            )}
          </ul>
        </aside>

        <section>{active && <WorkspaceDetail id={active} onChanged={load} />}</section>
      </div>

      {creating && (
        <CreateWorkspaceDialog
          onClose={() => setCreating(false)}
          onCreated={(r) => { setFreshKeys({ slug: r.slug, anon: r.keys.anon, service_role: r.keys.service_role }); setCreating(false); void load(); }}
        />
      )}
      {freshKeys && <NewKeysDialog kind="workspace" data={freshKeys} onClose={() => setFreshKeys(null)} />}
    </div>
  );
}

function WorkspaceDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [keys, setKeys] = useState<WorkspaceKey[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [mintedKey, setMintedKey] = useState<{ slug: string; kind: string; plaintext: string } | null>(null);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      const [k, m] = await Promise.all([live.workspaces.keys(id), live.workspaces.members(id)]);
      setKeys(k.keys);
      setMembers(m.members);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [id]);

  useEffect(() => { void reload(); }, [reload]);

  async function mint(kind: "anon" | "service_role") {
    try {
      const r = await live.workspaces.mintKey(id, kind, `${kind} minted from dashboard`);
      setMintedKey({ slug: id, kind: r.kind, plaintext: r.plaintext });
      void reload(); onChanged();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  async function revoke(keyId: string) {
    if (!confirm("Revoke this key? Clients using it will start receiving 401.")) return;
    try { await live.workspaces.revokeKey(id, keyId); void reload(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="space-y-4">
      {err && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{err}</div>
      )}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="inline-flex items-center gap-2 text-sm font-medium">
            <KeyRound className="h-4 w-4" /> API keys
          </div>
          <div className="flex gap-2">
            <button onClick={() => void mint("anon")} className="text-xs rounded-md border border-border px-2 py-1 hover:bg-accent">+ anon</button>
            <button onClick={() => void mint("service_role")} className="text-xs rounded-md border border-red-500/30 text-red-300 px-2 py-1 hover:bg-red-500/10">+ service_role</button>
          </div>
        </div>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-1.5">Kind</th>
              <th className="text-left px-3 py-1.5">Prefix</th>
              <th className="text-left px-3 py-1.5">Name</th>
              <th className="text-left px-3 py-1.5">Last used</th>
              <th className="text-left px-3 py-1.5">Uses</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className={"border-t border-border " + (k.revoked_at ? "opacity-40" : "")}>
                <td className="px-3 py-1.5">
                  <span className={"rounded px-1.5 py-0.5 text-[10px] " + (k.kind === "service_role" ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300")}>
                    {k.kind}
                  </span>
                </td>
                <td className="px-3 py-1.5 font-mono">{k.key_prefix}…</td>
                <td className="px-3 py-1.5">{k.name}</td>
                <td className="px-3 py-1.5">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "—"}</td>
                <td className="px-3 py-1.5">{k.use_count}</td>
                <td className="px-3 py-1.5 text-right">
                  {!k.revoked_at && (
                    <button onClick={() => void revoke(k.id)} className="text-muted-foreground hover:text-red-300">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {keys.length === 0 && <tr><td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">No keys.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-medium">
          <Users2 className="h-4 w-4" /> Members
        </div>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-1.5">Email</th>
              <th className="text-left px-3 py-1.5">Role</th>
              <th className="text-left px-3 py-1.5">Since</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id} className="border-t border-border">
                <td className="px-3 py-1.5">{m.email}</td>
                <td className="px-3 py-1.5">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{m.role}</span>
                </td>
                <td className="px-3 py-1.5">{new Date(m.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {members.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">No members.</td></tr>}
          </tbody>
        </table>
      </div>

      {mintedKey && (
        <NewKeysDialog
          kind={mintedKey.kind}
          data={{ slug: mintedKey.slug, [mintedKey.kind]: mintedKey.plaintext } as unknown as { slug: string; anon: string; service_role: string }}
          onClose={() => setMintedKey(null)}
        />
      )}
    </div>
  );
}

function CreateWorkspaceDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (r: { slug: string; keys: { anon: string; service_role: string } }) => void;
}) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-4">
        <h3 className="text-base font-semibold mb-3 inline-flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> New workspace
        </h3>
        <label className="block text-xs mb-1 text-muted-foreground">Slug (a-z0-9-_)</label>
        <input value={slug} onChange={(e) => setSlug(e.target.value)}
          className="w-full mb-3 rounded-md border border-border bg-background px-2 py-1.5 text-sm font-mono"
          placeholder="acme-prod" />
        <label className="block text-xs mb-1 text-muted-foreground">Display name</label>
        <input value={name} onChange={(e) => setName(e.target.value)}
          className="w-full mb-4 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          placeholder="Acme production" />
        {err && <div className="mb-3 text-xs text-red-300">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-sm hover:bg-accent">Cancel</button>
          <button
            disabled={busy || !slug || !name}
            onClick={async () => {
              setBusy(true); setErr(null);
              try { onCreated(await live.workspaces.create(slug, name)); }
              catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
              finally { setBusy(false); }
            }}
            className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewKeysDialog({ data, onClose }: { kind: string; data: { slug: string; anon?: string; service_role?: string }; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-4">
        <h3 className="text-base font-semibold mb-2 inline-flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> Copy your key(s) now
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          Plaintext keys are shown once. If you lose one, revoke it and mint a new one.
        </p>
        {(["anon", "service_role"] as const).map((k) =>
          data[k] ? (
            <div key={k} className="mb-3">
              <div className="text-[11px] uppercase text-muted-foreground mb-1">{k}</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-muted px-2 py-1.5 font-mono text-[11px] break-all">{data[k]}</code>
                <button onClick={() => void navigator.clipboard.writeText(data[k]!)}
                  className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent">
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : null
        )}
        <div className="text-right">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm">I've saved them</button>
        </div>
      </div>
    </div>
  );
}
