import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Check, Copy, KeyRound, Loader2, LogIn, Plus, RefreshCw, RotateCw, Server, Trash2, UserPlus } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/dashboard/pluto-admin")({
  component: PlutoAdminPage,
});

type Project = { id: string; name: string; slug: string; created_at: string };
type Member  = { user_id: string; email: string; role: string; created_at: string };
type ApiKey  = { id: string; name: string; key_prefix: string; role: string; created_at: string; revoked_at: string | null };

const LS_URL   = "pluto.upstream.url";
const LS_TOKEN = "pluto.upstream.token";

function useUpstream() {
  const [url, setUrl]     = useState(() => localStorage.getItem(LS_URL)   || "");
  const [token, setToken] = useState(() => localStorage.getItem(LS_TOKEN) || "");
  useEffect(() => { if (url) localStorage.setItem(LS_URL, url); }, [url]);
  useEffect(() => { if (token) localStorage.setItem(LS_TOKEN, token); }, [token]);
  return { url, setUrl, token, setToken };
}

async function api<T>(url: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${url.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || data?.message || res.statusText);
  return data as T;
}

function PlutoAdminPage() {
  const { url, setUrl, token, setToken } = useUpstream();
  const configured = useMemo(() => url.length > 0 && token.length > 0, [url, token]);

  const [tab, setTab] = useState<"projects" | "members" | "keys">("projects");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [members,  setMembers]  = useState<Member[]>([]);
  const [keys,     setKeys]     = useState<ApiKey[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [err,      setErr]      = useState<string | null>(null);
  const [minted,   setMinted]   = useState<string | null>(null);

  // Forms
  const [newProj, setNewProj]   = useState({ name: "", slug: "" });
  const [newMember, setNewMember] = useState({ user_id: "", role: "developer" });
  const [newKey, setNewKey]     = useState({ name: "", role: "anon" as "anon" | "authenticated" | "service_role" });

  async function login(email: string, password: string) {
    setLoading(true); setErr(null);
    try {
      const r = await api<{ access_token: string }>(url, "", "/auth/v1/token?grant_type=password", {
        method: "POST", body: JSON.stringify({ grant_type: "password", email, password }),
      });
      setToken(r.access_token);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }

  async function loadProjects() {
    setLoading(true); setErr(null);
    try { setProjects(await api<Project[]>(url, token, "/admin/v1/projects")); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  }
  async function loadMembers(id: string) {
    try { setMembers(await api<Member[]>(url, token, `/admin/v1/projects/${id}/members`)); }
    catch (e: any) { setErr(e.message); }
  }
  async function loadKeys(id: string) {
    try { setKeys(await api<ApiKey[]>(url, token, `/admin/v1/projects/${id}/keys`)); }
    catch (e: any) { setErr(e.message); }
  }

  useEffect(() => { if (configured) loadProjects(); /* eslint-disable-next-line */ }, [configured]);
  useEffect(() => {
    if (!configured || !selected) return;
    if (tab === "members") loadMembers(selected);
    if (tab === "keys")    loadKeys(selected);
    /* eslint-disable-next-line */
  }, [selected, tab]);

  async function createProject() {
    if (!newProj.name || !newProj.slug) return;
    try {
      const p = await api<Project>(url, token, "/admin/v1/projects", { method: "POST", body: JSON.stringify(newProj) });
      setProjects([p, ...projects]);
      setNewProj({ name: "", slug: "" });
    } catch (e: any) { setErr(e.message); }
  }
  async function deleteProject(id: string) {
    if (!confirm("Delete project?")) return;
    try { await api(url, token, `/admin/v1/projects/${id}`, { method: "DELETE" }); setProjects(projects.filter(p => p.id !== id)); }
    catch (e: any) { setErr(e.message); }
  }
  async function addMember() {
    if (!selected || !newMember.user_id) return;
    try {
      await api(url, token, `/admin/v1/projects/${selected}/members`, { method: "POST", body: JSON.stringify(newMember) });
      await loadMembers(selected); setNewMember({ user_id: "", role: "developer" });
    } catch (e: any) { setErr(e.message); }
  }
  async function removeMember(userId: string) {
    if (!selected) return;
    try { await api(url, token, `/admin/v1/projects/${selected}/members/${userId}`, { method: "DELETE" }); await loadMembers(selected); }
    catch (e: any) { setErr(e.message); }
  }
  async function createKey() {
    if (!selected || !newKey.name) return;
    try {
      const r = await api<ApiKey & { api_key: string }>(url, token, `/admin/v1/projects/${selected}/keys`, {
        method: "POST", body: JSON.stringify(newKey),
      });
      setMinted(r.api_key); setNewKey({ name: "", role: "anon" }); await loadKeys(selected);
    } catch (e: any) { setErr(e.message); }
  }
  async function revokeKey(id: string) {
    if (!selected) return;
    if (!confirm("Revoke this API key? Clients using it will immediately fail.")) return;
    try { await api(url, token, `/admin/v1/projects/${selected}/keys/${id}`, { method: "DELETE" }); await loadKeys(selected); }
    catch (e: any) { setErr(e.message); }
  }
  async function rotateKey(id: string) {
    if (!selected) return;
    if (!confirm("Rotate this key? The old key will be revoked and a replacement minted (shown once).")) return;
    try {
      const r = await api<ApiKey & { api_key: string }>(url, token, `/admin/v1/projects/${selected}/keys/${id}/rotate`, { method: "POST" });
      setMinted(r.api_key); await loadKeys(selected);
    } catch (e: any) { setErr(e.message); }
  }


  return (
    <div className="space-y-6">
      <PageHeader
        title="Pluto Admin"
        description="Manage your self-hosted Pluto BaaS on your VPS"
      />
      <AutoHelpPanel slug={'dashboard.pluto-admin'} title={'Pluto Admin'} description={'Manage your self-hosted Pluto BaaS on your VPS'} />


      {/* Connection */}
      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Server className="h-4 w-4"/> Upstream connection</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><Label>Upstream URL</Label><Input placeholder="https://api.your-domain.com" value={url} onChange={e => setUrl(e.target.value)} /></div>
            <div><Label>Admin JWT (paste or login below)</Label><Input placeholder="eyJhbGciOi..." value={token} onChange={e => setToken(e.target.value)} /></div>
          </div>
          <LoginRow onLogin={login} disabled={!url || loading} />
          {!configured && <Alert><AlertDescription>Set URL + token to load projects.</AlertDescription></Alert>}
          {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
        </CardContent>
      </Card>

      {configured && (
        <>
          <div className="flex gap-2">
            {(["projects", "members", "keys"] as const).map(t => (
              <Button key={t} variant={tab === t ? "default" : "outline"} size="sm" onClick={() => setTab(t)}>{t}</Button>
            ))}
            <Button variant="ghost" size="sm" onClick={loadProjects}><RefreshCw className="h-4 w-4"/></Button>
          </div>

          {tab === "projects" && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Projects</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input placeholder="Name" value={newProj.name} onChange={e => setNewProj({ ...newProj, name: e.target.value })}/>
                  <Input placeholder="slug (a-z0-9-)" value={newProj.slug} onChange={e => setNewProj({ ...newProj, slug: e.target.value })}/>
                  <Button onClick={createProject}><Plus className="h-4 w-4 mr-1"/>Create</Button>
                </div>
                <ul className="divide-y">
                  {projects.map(p => (
                    <li key={p.id} className="py-2 flex items-center justify-between">
                      <div>
                        <div className="font-medium">{p.name} <span className="text-muted-foreground text-xs">/{p.slug}</span></div>
                        <div className="text-xs text-muted-foreground font-mono">{p.id}</div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => { setSelected(p.id); setTab("members"); }}>Members</Button>
                        <Button size="sm" variant="outline" onClick={() => { setSelected(p.id); setTab("keys"); }}>Keys</Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteProject(p.id)}><Trash2 className="h-4 w-4 text-destructive"/></Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {tab === "members" && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Members {selected && <span className="text-muted-foreground font-mono text-xs">— project {selected.slice(0,8)}</span>}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {!selected && <div className="text-sm text-muted-foreground">Pick a project first.</div>}
                {selected && (
                  <>
                    <div className="flex gap-2">
                      <Input placeholder="user_id (uuid)" value={newMember.user_id} onChange={e => setNewMember({ ...newMember, user_id: e.target.value })}/>
                      <Select value={newMember.role} onValueChange={v => setNewMember({ ...newMember, role: v })}>
                        <SelectTrigger className="w-40"><SelectValue/></SelectTrigger>
                        <SelectContent>{["owner","admin","developer","viewer"].map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                      </Select>
                      <Button onClick={addMember}><UserPlus className="h-4 w-4 mr-1"/>Add</Button>
                    </div>
                    <ul className="divide-y">
                      {members.map(m => (
                        <li key={m.user_id} className="py-2 flex items-center justify-between">
                          <div><div>{m.email}</div><div className="text-xs text-muted-foreground font-mono">{m.user_id}</div></div>
                          <div className="flex items-center gap-2"><Badge variant="outline">{m.role}</Badge>
                            <Button size="sm" variant="ghost" onClick={() => removeMember(m.user_id)}><Trash2 className="h-4 w-4 text-destructive"/></Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {tab === "keys" && (
            <Card>
              <CardHeader><CardTitle className="text-sm flex items-center gap-2"><KeyRound className="h-4 w-4"/> API Keys</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {!selected && <div className="text-sm text-muted-foreground">Pick a project first.</div>}
                {selected && (
                  <>
                    <div className="flex gap-2">
                      <Input placeholder="Key name" value={newKey.name} onChange={e => setNewKey({ ...newKey, name: e.target.value })}/>
                      <Select value={newKey.role} onValueChange={v => setNewKey({ ...newKey, role: v as any })}>
                        <SelectTrigger className="w-40"><SelectValue/></SelectTrigger>
                        <SelectContent>{["anon","authenticated","service_role"].map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                      </Select>
                      <Button onClick={createKey}><Plus className="h-4 w-4 mr-1"/>Mint</Button>
                    </div>
                    <MintedKeyDialog value={minted} onClose={() => setMinted(null)} />
                    <ul className="divide-y">
                      {keys.map(k => (
                        <li key={k.id} className="py-2 flex items-center justify-between">
                          <div>
                            <div className="font-medium">{k.name} <Badge variant="outline" className="ml-2">{k.role}</Badge></div>
                            <div className="text-xs text-muted-foreground font-mono">{k.key_prefix}… · {new Date(k.created_at).toLocaleString()}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            {k.revoked_at
                              ? <Badge variant="destructive">revoked</Badge>
                              : (
                                <>
                                  <Button size="sm" variant="outline" onClick={() => rotateKey(k.id)} title="Rotate"><RotateCw className="h-4 w-4 mr-1"/>Rotate</Button>
                                  <Button size="sm" variant="ghost" onClick={() => revokeKey(k.id)} title="Revoke"><Trash2 className="h-4 w-4 text-destructive"/></Button>
                                </>
                              )}
                          </div>
                        </li>
                      ))}
                    </ul>

                  </>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function LoginRow({ onLogin, disabled }: { onLogin: (e: string, p: string) => void; disabled: boolean }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  return (
    <div className="flex gap-2 items-end">
      <div className="flex-1"><Label>Email</Label><Input value={email} onChange={e => setEmail(e.target.value)}/></div>
      <div className="flex-1"><Label>Password</Label><Input type="password" value={pw} onChange={e => setPw(e.target.value)}/></div>
      <Button disabled={disabled || !email || !pw} onClick={() => onLogin(email, pw)}>
        {disabled ? <Loader2 className="h-4 w-4 animate-spin"/> : <><LogIn className="h-4 w-4 mr-1"/>Sign in</>}
      </Button>
    </div>
  );
}

function MintedKeyDialog({ value, onClose }: { value: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [ack, setAck] = useState(false);
  useEffect(() => { if (value) { setCopied(false); setAck(false); } }, [value]);
  if (!value) return null;
  async function doCopy() {
    try { await navigator.clipboard.writeText(value!); setCopied(true); } catch { /* ignore */ }
  }
  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o && ack) onClose(); }}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4"/> Copy your new API key</DialogTitle>
          <DialogDescription>
            This key is shown <b>once</b>. Store it in a secret manager now — you will not be able to view it again.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 p-3 font-mono text-xs break-all select-all">{value}</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={doCopy}>
            {copied ? <Check className="h-4 w-4 mr-1"/> : <Copy className="h-4 w-4 mr-1"/>}
            {copied ? "Copied" : "Copy to clipboard"}
          </Button>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={ack} onCheckedChange={(v) => setAck(!!v)} />
          <span>I have saved this key. I understand it cannot be recovered.</span>
        </label>
        <DialogFooter>
          <Button disabled={!ack} onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
