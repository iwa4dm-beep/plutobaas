import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Copy, Database, ExternalLink, FolderKanban, KeyRound, Pencil, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { HelpPanel } from "@/components/help/HelpPanel";
import { dashboardProjectsHelp } from "@/content/help/dashboard.projects";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";
import { checkSlug, coerceSlug, previewSubdomainUrl, slugReasonMessage } from "@/lib/pluto/reserved-slugs";
import { isLive, live, type Workspace, type WorkspaceKey } from "@/lib/pluto/live";

type ConflictInfo = Awaited<ReturnType<typeof live.admin.apiKeys.checkConflict>>;
type IndexStatus = Awaited<ReturnType<typeof live.admin.apiKeys.verifyIndex>>;

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
  const [editing, setEditing] = useState<{ id: string; name: string; slug: string } | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [checkingConflict, setCheckingConflict] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [verifyingIndex, setVerifyingIndex] = useState(false);
  const slugStatus = useMemo(() => checkSlug(projectSlug), [projectSlug]);
  const editSlugStatus = useMemo(() => (editing ? checkSlug(editing.slug) : { ok: true as const }), [editing]);


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

  // Debounced conflict pre-check as user types name / picks kind.
  useEffect(() => {
    const name = newName.trim();
    if (!wsId || !name) { setConflict(null); return; }
    let cancelled = false;
    setCheckingConflict(true);
    const t = setTimeout(async () => {
      try {
        const c = await live.admin.apiKeys.checkConflict(wsId, name, newKind);
        if (!cancelled) setConflict(c);
      } catch { if (!cancelled) setConflict(null); }
      finally { if (!cancelled) setCheckingConflict(false); }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [wsId, newName, newKind]);

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
      setConflict(null);
      const { items } = await live.admin.apiKeys.list(wsId);
      setKeys(items);
    } catch (e) { setErr(e); }
  }

  async function resolveConflict(strategy: "revoke" | "rename") {
    if (!wsId || !newName.trim() || !conflict) return;
    setResolving(true);
    setErr(null);
    try {
      await live.admin.apiKeys.resolveConflict(wsId, {
        name: newName.trim(),
        kind: newKind,
        strategy,
        rename_to: strategy === "rename" ? conflict.suggestion?.rename_to : undefined,
      });
      const c = await live.admin.apiKeys.checkConflict(wsId, newName.trim(), newKind);
      setConflict(c);
      const { items } = await live.admin.apiKeys.list(wsId);
      setKeys(items);
    } catch (e) { setErr(e); }
    finally { setResolving(false); }
  }

  async function verifyIndex() {
    setVerifyingIndex(true);
    setErr(null);
    try {
      const s = await live.admin.apiKeys.verifyIndex();
      setIndexStatus(s);
    } catch (e) { setErr(e); }
    finally { setVerifyingIndex(false); }
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

  async function saveEdit() {
    if (!editing) return;
    if (!editing.name.trim() || !editSlugStatus.ok) return;
    setErr(null);
    try {
      await live.admin.projects.update(editing.id, { name: editing.name.trim(), slug: editing.slug.trim() });
      setEditing(null);
      setProjects(await live.admin.projects.list());
    } catch (e) { setErr(e); }
  }

  async function removeProject(id: string, name: string) {
    if (!confirm(`Delete project "${name}"? এই action reversible নয় — সব API keys revoke হয়ে যাবে।`)) return;
    setErr(null);
    try {
      await live.admin.projects.remove(id);
      setProjects(await live.admin.projects.list());
    } catch (e) { setErr(e); }
  }

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
      <HelpPanel help={dashboardProjectsHelp} />
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
            onChange={(e) => setProjectSlug(coerceSlug(e.target.value))}
            className="min-w-48 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
          <button
            onClick={createProject}
            disabled={!wsId || !projectName.trim() || !slugStatus.ok}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> Create
          </button>
        </div>
        {projectSlug && !slugStatus.ok && (
          <p className="mt-2 text-xs text-destructive">{slugReasonMessage(slugStatus.reason)}</p>
        )}
        {projectSlug && slugStatus.ok && (
          <p className="mt-2 text-xs text-muted-foreground">
            Preview URL: <a href={previewSubdomainUrl(projectSlug)} target="_blank" rel="noreferrer" className="font-mono text-foreground underline underline-offset-2">{previewSubdomainUrl(projectSlug)}</a>
          </p>
        )}
        <div className="mt-4 overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Project</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Slug</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Live URL</th>
                <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleProjects.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-center text-xs text-muted-foreground">No projects in this workspace yet.</td></tr>}
              {visibleProjects.map((p) => {
                const url = previewSubdomainUrl(p.slug);
                const isEditing = editing?.id === p.id;
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      {isEditing ? (
                        <input
                          value={editing!.name}
                          onChange={(e) => setEditing({ ...editing!, name: e.target.value })}
                          className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                        />
                      ) : p.name}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {isEditing ? (
                        <input
                          value={editing!.slug}
                          onChange={(e) => setEditing({ ...editing!, slug: coerceSlug(e.target.value) })}
                          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs font-mono"
                        />
                      ) : p.slug}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-foreground underline underline-offset-2">
                        {url} <ExternalLink className="h-3 w-3" />
                      </a>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        {isEditing ? (
                          <>
                            <button
                              onClick={saveEdit}
                              disabled={!editing!.name.trim() || !editSlugStatus.ok}
                              className="rounded-md border border-input p-1 hover:bg-accent disabled:opacity-50"
                              title="Save"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => setEditing(null)}
                              className="rounded-md border border-input p-1 hover:bg-accent"
                              title="Cancel"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => setEditing({ id: p.id, name: p.name, slug: p.slug })}
                              className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent"
                              title="Rename"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => removeProject(p.id, p.name)}
                              className="rounded-md p-1 text-muted-foreground hover:text-destructive hover:bg-accent"
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
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
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-medium">API keys</h2>
          </div>
          <button
            onClick={verifyIndex}
            disabled={verifyingIndex}
            className="inline-flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
            title="Verify api_keys unique index status"
          >
            <Database className="h-3 w-3" /> {verifyingIndex ? "Checking…" : "Verify DB index"}
          </button>
        </div>

        {indexStatus && (
          <div className={
            "mb-4 rounded-md border p-3 text-xs " +
            (indexStatus.status === "ok"
              ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
              : "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400")
          }>
            <div className="flex items-start gap-2">
              {indexStatus.status === "ok"
                ? <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
                : <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />}
              <div className="flex-1">
                <div className="font-medium">
                  {indexStatus.status === "ok" ? "Migration 0039 active" : `Index status: ${indexStatus.status}`}
                </div>
                <div className="opacity-90">{indexStatus.message}</div>
                {indexStatus.status !== "ok" && (
                  <code className="mt-1 block font-mono text-[10px]">
                    docker exec -i docker-postgres-1 psql -U postgres -d pluto {"<"} pluto-backend/migrations/0039_api_keys_unique_per_kind.sql
                  </code>
                )}
              </div>
              <button onClick={() => setIndexStatus(null)} className="text-inherit opacity-60 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
            </div>
          </div>
        )}

        <div className="mb-2 flex gap-2">
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
          <button
            onClick={mint}
            disabled={!!conflict?.conflict || !newName.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> Mint
          </button>
        </div>
        <div className="mb-4 min-h-[1rem] text-xs">
          {checkingConflict && <span className="text-muted-foreground">Checking for conflicts…</span>}
          {!checkingConflict && conflict?.conflict && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <div className="font-medium">
                    Duplicate conflict — constraint <code className="font-mono">api_keys_project_name{conflict.blocking_kind_match ? "_kind" : ""}_idx</code> blocks mint.
                  </div>
                  <ul className="mt-1 list-disc pl-4 text-[11px] opacity-90">
                    {conflict.blocking.slice(0, 3).map((b) => (
                      <li key={b.id}>
                        <code className="font-mono">{b.name}</code> ({b.kind}) in project <code className="font-mono">{b.project_slug}</code>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      onClick={() => resolveConflict("revoke")}
                      disabled={resolving}
                      className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" /> Revoke conflicting ({conflict.blocking.length})
                    </button>
                    {conflict.suggestion && (
                      <button
                        onClick={() => resolveConflict("rename")}
                        disabled={resolving}
                        className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-50"
                      >
                        <Pencil className="h-3 w-3" /> Rename to <code className="font-mono">{conflict.suggestion.rename_to}</code>
                      </button>
                    )}
                  </div>
                  {!conflict.blocking_kind_match && (
                    <p className="mt-2 text-[11px] opacity-80">
                      Legacy index active — anon + service_role এখনো share name করতে পারছে না। উপরে "Verify DB index" চাপুন এবং migration 0039 apply করুন।
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
          {!checkingConflict && conflict && !conflict.conflict && newName.trim() && (
            <span className="text-emerald-600">✓ Available — no conflict for "{newName.trim()}" ({newKind}).</span>
          )}
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
