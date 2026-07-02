import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2, Send, Copy } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import {
  isLive, devex, type PersonalToken, type ProjectTemplate,
  type WebhookSub, type WebhookDelivery, type InstalledPlugin,
} from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/devex")({ component: DevexPage });

// Developer Experience console (Phase 19). Manages project templates,
// personal access tokens, outgoing webhooks (with test pings and
// delivery history), and the installed plugin catalog.

function DevexPage() {
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [tokens, setTokens] = useState<PersonalToken[]>([]);
  const [hooks, setHooks] = useState<WebhookSub[]>([]);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<{ token: string; name: string } | null>(null);

  const [tokenName, setTokenName] = useState("");
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

  const mint = async () => {
    if (!tokenName) return;
    try {
      const r = await devex.mintToken({ name: tokenName, scopes: ["read", "write"] });
      setFreshToken({ token: r.token, name: r.meta.name });
      setTokenName(""); await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
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
    try { await devex.testWebhook(id); const d = await devex.deliveries(id); setDeliveries((m) => ({ ...m, [id]: d.deliveries })); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const showDeliveries = async (id: string) => {
    const d = await devex.deliveries(id); setDeliveries((m) => ({ ...m, [id]: d.deliveries }));
  };

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

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Personal access tokens</div>
        <div className="flex gap-2">
          <input value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="CI deploy token"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          <button onClick={() => void mint()}
            className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm">Mint token</button>
        </div>
        <ul className="text-sm divide-y divide-border">
          {tokens.length === 0 && <li className="py-2 text-muted-foreground">No tokens yet.</li>}
          {tokens.map((t) => (
            <li key={t.id} className="py-2 flex items-center justify-between gap-2">
              <span className="font-medium">{t.name}</span>
              <span className="text-xs text-muted-foreground">{t.scopes.join(", ")}</span>
              <span className="text-xs text-muted-foreground">{t.revoked_at ? "revoked" : "active"}</span>
              {!t.revoked_at && (
                <button onClick={() => void revoke(t.id)}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
                  <Trash2 className="h-3 w-3 inline" /> revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

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
          {hooks.map((h) => (
            <li key={h.id} className="py-2 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs truncate flex-1">{h.target_url}</span>
                <span className="text-xs text-muted-foreground">events: {h.event_types.join(",")}</span>
                <span className={`text-xs ${h.failure_count > 0 ? "text-rose-500" : "text-emerald-500"}`}>{h.active ? "active" : "off"} · {h.failure_count} fail</span>
                <button onClick={() => void ping(h.id)}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
                  <Send className="h-3 w-3 inline" /> ping
                </button>
                <button onClick={() => void showDeliveries(h.id)}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">history</button>
              </div>
              {deliveries[h.id] && (
                <ul className="text-xs pl-3 space-y-0.5">
                  {deliveries[h.id].slice(0, 5).map((d) => (
                    <li key={d.id} className="text-muted-foreground">
                      {new Date(d.attempted_at).toLocaleTimeString()} · {d.event_type} · {d.status_code ?? "err"} · {d.response_ms ?? "–"}ms
                      {d.error && <span className="text-rose-500"> · {d.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
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
