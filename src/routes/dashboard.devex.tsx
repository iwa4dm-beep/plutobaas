import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2, Send, Copy, RotateCw, ChevronDown, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import {
  isLive, devex, DEVEX_TOKEN_SCOPES,
  type DevexTokenScope, type PersonalToken, type ProjectTemplate,
  type WebhookSub, type WebhookDelivery, type InstalledPlugin,
} from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/devex")({ component: DevexPage });

// Phase 19 console — extended with scoped/expiring token minting and
// failed-delivery replay for outbound webhooks.

const EXPIRY_PRESETS: { label: string; days: number | null }[] = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "Never", days: null },
];

function DevexPage() {
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [tokens, setTokens] = useState<PersonalToken[]>([]);
  const [hooks, setHooks] = useState<WebhookSub[]>([]);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [openHistory, setOpenHistory] = useState<Record<string, boolean>>({});
  const [replaying, setReplaying] = useState<Record<string, boolean>>({});
  const [replayResult, setReplayResult] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<{ token: string; name: string } | null>(null);

  const [tokenName, setTokenName] = useState("");
  const [tokenScopes, setTokenScopes] = useState<Set<DevexTokenScope>>(new Set(["read"]));
  const [tokenExpiryDays, setTokenExpiryDays] = useState<number | null>(30);
  const [minting, setMinting] = useState(false);

  const [hookUrl, setHookUrl] = useState("");
  const [freshSecret, setFreshSecret] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isLive()) { setErr("Live backend not configured. Set VITE_PLUTO_URL."); return; }
    setLoading(true); setErr(null);
    try {
      const [t, k, h, p] = await Promise.all([
        devex.templates(), devex.tokens(), devex.webhooks(), devex.plugins(),
      ]);
      setTemplates(t.templates); setTokens(k.tokens); setHooks(h.subscriptions); setPlugins(p.installed);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggleScope = (s: DevexTokenScope) => {
    setTokenScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      if (next.size === 0) next.add("read"); // enforce least-privilege minimum
      return next;
    });
  };

  const mint = async () => {
    if (!tokenName) return;
    if (tokenScopes.size === 0) { setErr("Select at least one scope."); return; }
    setMinting(true);
    try {
      const r = await devex.mintToken({
        name: tokenName,
        scopes: Array.from(tokenScopes),
        expires_in_days: tokenExpiryDays,
      });
      setFreshToken({ token: r.token, name: r.meta.name });
      setTokenName(""); setTokenScopes(new Set(["read"])); setTokenExpiryDays(30);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setMinting(false); }
  };
  const revoke = async (id: string) => { await devex.revokeToken(id); await load(); };

  const createHook = async () => {
    if (!hookUrl) return;
    try {
      const r = await devex.createWebhook({ target_url: hookUrl, event_types: ["*"] });
      setFreshSecret(r.secret); setHookUrl(""); await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const ping = async (id: string) => {
    try { await devex.testWebhook(id); const d = await devex.deliveries(id); setDeliveries((m) => ({ ...m, [id]: d.deliveries })); setOpenHistory((m) => ({ ...m, [id]: true })); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const showDeliveries = async (id: string) => {
    setOpenHistory((m) => ({ ...m, [id]: !m[id] }));
    if (!deliveries[id]) {
      const d = await devex.deliveries(id); setDeliveries((m) => ({ ...m, [id]: d.deliveries }));
    }
  };
  const replayDelivery = async (hookId: string, delivery: WebhookDelivery) => {
    const key = `${hookId}:${delivery.id}`;
    setReplaying((m) => ({ ...m, [key]: true }));
    setReplayResult((m) => ({ ...m, [key]: "" }));
    try {
      const r = await devex.replayDelivery(hookId, delivery.id);
      setReplayResult((m) => ({
        ...m,
        [key]: r.error ? `error: ${r.error}` : `HTTP ${r.status_code ?? "—"} · ${r.response_ms}ms`,
      }));
      const d = await devex.deliveries(hookId);
      setDeliveries((m) => ({ ...m, [hookId]: d.deliveries }));
    } catch (e) {
      setReplayResult((m) => ({ ...m, [key]: `failed: ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      setReplaying((m) => ({ ...m, [key]: false }));
    }
  };
  const toggleExpanded = (key: string) => setExpanded((m) => ({ ...m, [key]: !m[key] }));

  const failed = (d: WebhookDelivery) => d.error != null || (d.status_code != null && (d.status_code < 200 || d.status_code >= 300));

  return (
    <div className="space-y-6">
      <PageHeader title="Developer Experience"
        description="Project templates, personal access tokens, outbound webhooks and installed plugins (Phase 19)" />
      <div className="flex justify-end">
        <button onClick={() => void load()}
          className="inline-flex items-center gap-2 text-sm rounded-md border border-border px-3 py-1.5 hover:bg-accent">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
        </button>
      </div>

      {err && <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-500">{err}</div>}

      {freshToken && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          <div className="font-semibold mb-1">Copy your new token for “{freshToken.name}” — shown only once</div>
          <div className="flex items-center gap-2">
            <code className="text-xs bg-background px-2 py-1 rounded flex-1 truncate">{freshToken.token}</code>
            <button onClick={() => navigator.clipboard.writeText(freshToken.token)}
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
              <Copy className="h-3 w-3 inline" /> Copy
            </button>
            <button onClick={() => setFreshToken(null)} className="text-xs text-muted-foreground">dismiss</button>
          </div>
        </div>
      )}

      {/* ---------------- PATs with scope + expiry ---------------- */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Personal access tokens</div>
        <div className="text-xs text-muted-foreground">
          Grant only the scopes each token needs and set an expiration to enforce least-privilege access.
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs space-y-1">
            <div className="text-muted-foreground">Name</div>
            <input value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="CI deploy token"
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm" />
          </label>
          <label className="text-xs space-y-1">
            <div className="text-muted-foreground">Expires</div>
            <select value={tokenExpiryDays === null ? "never" : String(tokenExpiryDays)}
              onChange={(e) => setTokenExpiryDays(e.target.value === "never" ? null : Number(e.target.value))}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm">
              {EXPIRY_PRESETS.map((p) => (
                <option key={p.label} value={p.days === null ? "never" : String(p.days)}>{p.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="text-xs space-y-1">
          <div className="text-muted-foreground">Scopes ({tokenScopes.size} selected)</div>
          <div className="flex flex-wrap gap-1.5">
            {DEVEX_TOKEN_SCOPES.map((s) => {
              const on = tokenScopes.has(s);
              return (
                <button key={s} type="button" onClick={() => toggleScope(s)}
                  className={`rounded-md border px-2 py-1 text-xs font-mono transition-colors ${
                    on ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-accent"
                  }`}>
                  {on ? "✓ " : ""}{s}
                </button>
              );
            })}
          </div>
          {tokenScopes.has("admin") && (
            <div className="text-xs text-amber-500">⚠ admin grants full access — avoid unless the token is for internal ops.</div>
          )}
        </div>
        <div className="flex justify-end">
          <button onClick={() => void mint()} disabled={minting || !tokenName}
            className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm disabled:opacity-50 inline-flex items-center gap-1.5">
            {minting && <Loader2 className="h-3 w-3 animate-spin" />} Mint token
          </button>
        </div>
        <ul className="text-sm divide-y divide-border">
          {tokens.length === 0 && <li className="py-2 text-muted-foreground">No tokens yet.</li>}
          {tokens.map((t) => {
            const expired = t.expires_at && new Date(t.expires_at).getTime() < Date.now();
            return (
              <li key={t.id} className="py-2 flex items-center justify-between gap-2 flex-wrap">
                <span className="font-medium">{t.name}</span>
                <span className="text-xs text-muted-foreground font-mono">{t.scopes.join(" · ")}</span>
                <span className="text-xs text-muted-foreground">
                  {t.expires_at ? (expired ? "expired " : "expires ") + new Date(t.expires_at).toLocaleDateString() : "no expiry"}
                </span>
                <span className={`text-xs ${t.revoked_at ? "text-rose-500" : expired ? "text-amber-500" : "text-emerald-500"}`}>
                  {t.revoked_at ? "revoked" : expired ? "expired" : "active"}
                </span>
                {!t.revoked_at && (
                  <button onClick={() => void revoke(t.id)}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
                    <Trash2 className="h-3 w-3 inline" /> revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* ---------------- Webhooks with replay ---------------- */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Outbound webhooks</div>
        <div className="text-xs text-muted-foreground">
          Each delivery is HMAC-SHA256 signed via <code>x-pluto-signature</code>. Verify on your side using the secret shown at creation.
        </div>
        <div className="flex gap-2">
          <input value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://api.example.com/hooks/pluto"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          <button onClick={() => void createHook()}
            className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm">Subscribe</button>
        </div>
        {freshSecret && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
            <div className="font-semibold mb-1">HMAC secret (shown once)</div>
            <code className="break-all">{freshSecret}</code>
            <button onClick={() => setFreshSecret(null)} className="ml-2 text-muted-foreground">dismiss</button>
          </div>
        )}
        <ul className="text-sm divide-y divide-border">
          {hooks.length === 0 && <li className="py-2 text-muted-foreground">No subscriptions.</li>}
          {hooks.map((h) => {
            const list = deliveries[h.id] ?? [];
            const isOpen = !!openHistory[h.id];
            return (
              <li key={h.id} className="py-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs truncate flex-1 min-w-[180px]">{h.target_url}</span>
                  <span className="text-xs text-muted-foreground">events: {h.event_types.join(",")}</span>
                  <span className={`text-xs ${h.failure_count > 0 ? "text-rose-500" : "text-emerald-500"}`}>{h.active ? "active" : "off"} · {h.failure_count} fail</span>
                  <button onClick={() => void ping(h.id)}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
                    <Send className="h-3 w-3 inline" /> ping
                  </button>
                  <button onClick={() => void showDeliveries(h.id)}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent inline-flex items-center gap-1">
                    {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} history
                  </button>
                </div>
                {isOpen && (
                  <ul className="text-xs pl-3 space-y-1 border-l border-border/60">
                    {list.length === 0 && <li className="text-muted-foreground italic py-1">No deliveries recorded yet.</li>}
                    {list.slice(0, 10).map((d) => {
                      const key = `${h.id}:${d.id}`;
                      const isFail = failed(d);
                      const isExp = !!expanded[key];
                      const rr = replayResult[key];
                      return (
                        <li key={d.id} className="py-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${isFail ? "bg-rose-500/15 text-rose-500" : "bg-emerald-500/15 text-emerald-500"}`}>
                              {isFail ? "FAIL" : "OK"}
                            </span>
                            <span className="text-muted-foreground">{new Date(d.attempted_at).toLocaleTimeString()}</span>
                            <span className="font-mono">{d.event_type}</span>
                            <span className="text-muted-foreground">{d.status_code ?? "err"} · {d.response_ms ?? "–"}ms</span>
                            {d.error && <span className="text-rose-500 truncate max-w-[200px]" title={d.error}>{d.error}</span>}
                            <span className="flex-1" />
                            {(d.payload !== undefined || d.headers !== undefined) && (
                              <button onClick={() => toggleExpanded(key)}
                                className="text-muted-foreground hover:text-foreground">
                                {isExp ? "hide" : "view"} payload
                              </button>
                            )}
                            {isFail && (
                              <button onClick={() => void replayDelivery(h.id, d)}
                                disabled={replaying[key]}
                                className="rounded-md border border-border px-2 py-0.5 text-[10px] hover:bg-accent inline-flex items-center gap-1 disabled:opacity-50">
                                {replaying[key] ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                                replay
                              </button>
                            )}
                          </div>
                          {rr && <div className="text-[11px] mt-0.5 text-muted-foreground">↻ replay result: {rr}</div>}
                          {isExp && (
                            <div className="mt-1 space-y-1">
                              {d.headers && (
                                <details open className="bg-muted/40 rounded p-1.5">
                                  <summary className="cursor-pointer text-muted-foreground">headers</summary>
                                  <pre className="text-[10px] overflow-x-auto">{JSON.stringify(d.headers, null, 2)}</pre>
                                </details>
                              )}
                              {d.payload !== undefined && (
                                <details open className="bg-muted/40 rounded p-1.5">
                                  <summary className="cursor-pointer text-muted-foreground">payload</summary>
                                  <pre className="text-[10px] overflow-x-auto">{typeof d.payload === "string" ? d.payload : JSON.stringify(d.payload, null, 2)}</pre>
                                </details>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Project templates</div>
        <ul className="text-sm divide-y divide-border">
          {templates.length === 0 && <li className="py-2 text-muted-foreground">No published templates yet.</li>}
          {templates.map((t) => (
            <li key={t.id} className="py-2 flex items-center justify-between gap-2">
              <span className="font-medium">{t.name}</span>
              <span className="text-xs text-muted-foreground truncate flex-1 mx-2">{t.description}</span>
              <span className="text-xs bg-muted px-2 py-0.5 rounded">{t.category}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Installed plugins</div>
        <ul className="text-sm divide-y divide-border">
          {plugins.length === 0 && <li className="py-2 text-muted-foreground">No plugins installed.</li>}
          {plugins.map((p) => (
            <li key={p.id} className="py-2 flex items-center justify-between gap-2">
              <span className="font-mono text-xs">{p.plugin_slug}</span>
              <span className="text-xs text-muted-foreground">v{p.version}</span>
              <span className={`text-xs ${p.enabled ? "text-emerald-500" : "text-muted-foreground"}`}>{p.enabled ? "enabled" : "disabled"}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
