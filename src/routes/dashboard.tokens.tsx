import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { KeyRound, Plus, Trash2, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { isLive, tokens, type WorkspaceToken, type WorkspaceTokenMint } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/tokens")({ component: TokensPage });

function TokensPage() {
  const [rows, setRows] = useState<WorkspaceToken[]>([]);
  const [scopeCatalog, setScopeCatalog] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [expiresDays, setExpiresDays] = useState<string>("");
  const [minted, setMinted] = useState<WorkspaceTokenMint | null>(null);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    if (!isLive()) return;
    try {
      const [t, s] = await Promise.all([tokens.list(), tokens.scopes()]);
      setRows(t.tokens); setScopeCatalog(s.scopes);
    } catch (e) { toast.error((e as Error).message); }
  }
  useEffect(() => { void refresh(); }, []);

  async function create() {
    const scopes = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
    if (!name.trim()) { toast.error("Name is required."); return; }
    if (scopes.length === 0) { toast.error("Pick at least one scope."); return; }
    const days = expiresDays.trim() ? Number(expiresDays) : undefined;
    if (days !== undefined && (!Number.isFinite(days) || days < 1 || days > 365)) {
      toast.error("Expires must be 1..365 days."); return;
    }
    try {
      const m = await tokens.create({ name: name.trim(), scopes, expires_in_days: days });
      setMinted(m); setName(""); setSelected({}); setExpiresDays(""); setCopied(false);
      toast.success("Token created — copy it now, it won't be shown again.");
      await refresh();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this token? Clients using it will start receiving 403 immediately.")) return;
    try { await tokens.revoke(id); toast.success("Token revoked"); refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><KeyRound className="h-5 w-5" /> API Tokens</h1>
        <p className="text-sm text-muted-foreground">Workspace-scoped bearer tokens with granular scopes. Use for CI, scripts, and external integrations.</p>
      </div>

      {!isLive() && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs">
          Set <code>VITE_PLUTO_URL</code> to a running Pluto instance to manage tokens.
        </div>
      )}

      {minted && (
        <Card className="border-primary/40">
          <CardHeader><CardTitle className="text-sm">Copy your new token — shown once</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-xs p-2 rounded-md bg-muted break-all">{minted.token}</code>
              <Button size="sm" variant="outline" onClick={async () => {
                try { await navigator.clipboard.writeText(minted.token); setCopied(true); toast.success("Copied"); }
                catch { toast.error("Copy failed"); }
              }}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</Button>
              <Button size="sm" variant="ghost" onClick={() => setMinted(null)}>Dismiss</Button>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Prefix <span className="font-mono">{minted.prefix}</span> · scopes: {minted.scopes.join(", ")}
              {minted.expires_at && <> · expires {new Date(minted.expires_at).toLocaleString()}</>}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Plus className="h-4 w-4" /> Create token</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[1fr,160px,90px] gap-2">
            <Input placeholder="Human-readable name (e.g. github-actions)" value={name} onChange={e => setName(e.target.value)} />
            <Input type="number" placeholder="expires in days (blank = never)" value={expiresDays}
                   onChange={e => setExpiresDays(e.target.value)} min={1} max={365} />
            <Button size="sm" onClick={create}><Plus className="h-4 w-4 mr-1" /> Create</Button>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Scopes</div>
            <div className="flex flex-wrap gap-1">
              {scopeCatalog.map(s => {
                const on = !!selected[s];
                return (
                  <button key={s} type="button" onClick={() => setSelected(v => ({ ...v, [s]: !on }))}
                          className={"text-[11px] px-2 py-1 rounded border font-mono " +
                            (on ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-accent")}>{s}</button>
                );
              })}
              <button type="button" onClick={() => setSelected(v => ({ ...v, "*": !v["*"] }))}
                      className={"text-[11px] px-2 py-1 rounded border font-mono " +
                        (selected["*"] ? "bg-destructive text-destructive-foreground border-destructive" : "border-border hover:bg-accent")}>
                * (all scopes)
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Existing tokens ({rows.length})</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-1">
            {rows.map(t => {
              const expired = t.expires_at && new Date(t.expires_at).getTime() < Date.now();
              const revoked = !!t.revoked_at;
              return (
                <div key={t.id} className="grid grid-cols-[1fr,90px,180px,180px,90px] gap-2 items-center text-xs p-2 border border-border rounded-md">
                  <div>
                    <div className="font-medium">{t.name}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">plt_{t.prefix}_… · {t.scopes.join(", ")}</div>
                  </div>
                  <Badge variant={revoked ? "destructive" : expired ? "secondary" : "default"}>
                    {revoked ? "revoked" : expired ? "expired" : "active"}
                  </Badge>
                  <span className="text-muted-foreground">created {new Date(t.created_at).toLocaleString()}</span>
                  <span className="text-muted-foreground">last used {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "—"}</span>
                  <div className="flex justify-end">
                    {!revoked && (
                      <Button size="sm" variant="ghost" title="Revoke" onClick={() => revoke(t.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {rows.length === 0 && <div className="text-xs text-muted-foreground">No tokens minted yet.</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
