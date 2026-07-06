import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Copy, FolderKanban, KeyRound, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";
import { isLive, live, type Workspace, type WorkspaceKey } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/projects")({
  component: ProjectsPage,
});


function ProjectsPage() {
  const [copied, setCopied] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string; slug: string; workspace_id?: string | null }>>([]);
  const [wsId, setWsId] = useState<string | null>(null);
  const [keys, setKeys] = useState<WorkspaceKey[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [minted, setMinted] = useState<{ name: string; plaintext: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<"anon" | "service_role">("anon");
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");

  const loadTop = useCallback(async () => {
    if (!isLive()) return;
    setErr(null);
    try {
      const { workspaces: ws } = await live.workspaces.list();
      setWorkspaces(ws);
      if (ws.length && !wsId) setWsId(ws[0].id);
      setProjects(await live.admin.projects.list());
    } catch (e) { setErr(e); }
  }, [wsId]);

  const loadKeys = useCallback(async () => {
    if (!isLive() || !wsId) return;
    setErr(null);
    try {
      const { items } = await live.admin.apiKeys.list(wsId);
      setKeys(items);
    } catch (e) { setErr(e); }
  }, [wsId]);

  useEffect(() => { void loadTop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadKeys(); }, [loadKeys]);


  function copy(v: string) {
    navigator.clipboard.writeText(v);
    setCopied(v);
    setTimeout(() => setCopied(null), 1200);
  }

  async function mint() {
    if (!wsId || !newName.trim()) return;
    setErr(null);
    try {
      const r = await live.admin.apiKeys.mint(wsId, newName.trim(), newKind);
      setMinted({ name: r.name, plaintext: r.plaintext });
      setNewName("");
      const { items } = await live.admin.apiKeys.list(wsId);
      setKeys(items);
    } catch (e) { setErr(e); }
  }

  async function createProject() {
    if (!wsId || !projectName.trim() || !projectSlug.trim()) return;
    setErr(null);
    try {
      await live.admin.projects.create({ name: projectName.trim(), slug: projectSlug.trim(), workspace_id: wsId });
      setProjectName("");
      setProjectSlug("");
      setProjects(await live.admin.projects.list());
    } catch (e) { setErr(e); }
  }

  const visibleProjects = projects.filter((p) => !wsId || !p.workspace_id || p.workspace_id === wsId);

  async function revoke(id: string) {
    if (!wsId) return;
    try {
      await live.admin.apiKeys.revoke(wsId, id);
      const { items } = await live.admin.apiKeys.list(wsId);
      setKeys(items);
    } catch (e) { setErr(e); }
  }

  if (!isLive()) {
    return (
      <div>
        <PageHeader title="Projects & API Keys" description="Backend not configured." />
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
          Pluto backend URL এবং anon key configure করা নেই। Environment variables set করে reload করুন।
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Projects & API Keys"
        description="Workspace বেছে নিন এবং API key mint/revoke করুন। (live)"
        actions={
          <select
            value={wsId ?? ""}
            onChange={(e) => setWsId(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          >
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        }
      />

      <ErrorBanner
        error={err}
        onRetry={() => { void loadTop(); void loadKeys(); }}
        onDismiss={() => setErr(null)}
      />


      <div className="mb-4 rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <FolderKanban className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-medium">Create project</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            placeholder="Project name"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="min-w-56 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <input
            placeholder="project-slug"
            value={projectSlug}
            onChange={(e) => setProjectSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            className="min-w-48 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
          <button
            onClick={createProject}
            disabled={!wsId || !projectName.trim() || !projectSlug.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> Create
          </button>
        </div>
        <div className="mt-4 overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Project</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Slug</th>
              </tr>
            </thead>
            <tbody>
              {visibleProjects.length === 0 && <tr><td colSpan={2} className="px-3 py-4 text-center text-xs text-muted-foreground">No projects in this workspace yet.</td></tr>}
              {visibleProjects.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2">{p.name}</td>
                  <td className="px-3 py-2 font-mono text-xs">{p.slug}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {minted && (
        <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
          <div className="text-sm font-medium">Key "{minted.name}" minted — copy it now.</div>
          <p className="text-xs text-muted-foreground mt-1">
            এই key শুধু এক বারই দেখানো হবে; পরে হারিয়ে গেলে revoke করে নতুন mint করতে হবে।
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono">{minted.plaintext}</code>
            <button onClick={() => copy(minted.plaintext)} className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs hover:bg-accent">
              <Copy className="h-3.5 w-3.5" />{copied === minted.plaintext ? "Copied" : "Copy"}
            </button>
            <button onClick={() => setMinted(null)} className="rounded-md border border-input px-3 py-2 text-xs hover:bg-accent">Dismiss</button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-medium">API keys</h2>
        </div>

        <div className="mb-4 flex gap-2">
          <input
            placeholder="Key name (e.g. mobile-prod)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as "anon" | "service_role")} className="rounded-md border border-input bg-background px-2 py-2 text-sm">
            <option value="anon">anon</option>
            <option value="service_role">service_role</option>
          </select>
          <button onClick={mint} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90">
            <Plus className="h-3.5 w-3.5" /> Mint
          </button>
        </div>

        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Name</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Kind</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Prefix</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Used</th>
              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-muted-foreground">No keys yet — mint one above.</td></tr>}
            {keys.map((k) => (
              <tr key={k.id} className="border-t border-border">
                <td className="px-3 py-2">{k.name}</td>
                <td className="px-3 py-2 text-xs"><code className={k.kind === "service_role" ? "text-destructive" : ""}>{k.kind}</code></td>
                <td className="px-3 py-2 font-mono text-xs">{k.key_prefix}…</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{k.use_count}</td>
                <td className="px-3 py-2 text-xs">
                  {k.revoked_at
                    ? <span className="rounded bg-muted px-1.5 py-0.5">revoked</span>
                    : <span className="rounded bg-emerald-500/15 text-emerald-600 px-1.5 py-0.5">active</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  {!k.revoked_at && (
                    <button onClick={() => revoke(k.id)} className="text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="mt-6 text-xs text-muted-foreground">
          ⚠️ <span className="font-medium">service_role</span> key কখনো frontend-এ ব্যবহার করবেন না — এটি RLS bypass করে।
        </p>
      </div>
    </div>
  );
}

function Field({ label, value, onCopy, copied, danger }: { label: string; value: string; onCopy: (v: string) => void; copied: string | null; danger?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1.5">{label}</div>
      <div className="flex items-center gap-2">
        <code className={"flex-1 rounded-md border border-input bg-muted/40 px-3 py-2 text-xs font-mono " + (danger ? "text-destructive" : "")}>{value}</code>
        <button
          onClick={() => onCopy(value)}
          className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs hover:bg-accent"
        >
          <Copy className="h-3.5 w-3.5" />
          {copied === value ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
