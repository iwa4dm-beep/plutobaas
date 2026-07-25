import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ArrowLeft, Plus, Trash2, Save, Send } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/pluto/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  adminTraces, isLive,
  type PiiRule, type AlertWebhook,
} from "@/lib/pluto/live";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";

export const Route = createFileRoute("/dashboard/traces/settings")({
  head: () => ({
    meta: [
      { title: "Trace settings — PII redaction & alert webhooks" },
      { name: "description", content: "Manage PII redaction rules applied to trace exports and configure spike-alert webhooks." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: GatedSettingsPage,
});

function GatedSettingsPage() {
  return (
    <TraceAccessGate permission="manage">
      <SettingsPage />
    </TraceAccessGate>
  );
}

const APPLIES = ["all","message","hint","detail","stack","url","fields","user_agent"] as const;

function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Trace settings"
        description="PII redaction rules are applied to every trace shown in the viewer, in exports, and to stack traces. Alert webhooks receive spike alerts with traceId samples and deep-links back into this dashboard."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/dashboard/traces"><ArrowLeft className="h-4 w-4 mr-1.5" /> Trace viewer</Link>
          </Button>
        }
      />
      <PiiRulesCard />
      <WebhooksCard />
    </div>
  );
}

// -------------------------------------------------------------- PII rules
function PiiRulesCard() {
  const [rules, setRules] = useState<PiiRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", pattern: "", applies_to: ["all"], replacement: "[REDACTED]" });

  const load = useCallback(async () => {
    if (!isLive()) { setErr("Live backend not configured."); return; }
    setLoading(true); setErr(null);
    try { const r = await adminTraces.listRules(); setRules(r.rules); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!draft.name.trim() || !draft.pattern.trim()) { toast.error("Name and pattern required"); return; }
    try {
      await adminTraces.createRule({
        name: draft.name.trim(),
        pattern: draft.pattern.trim(),
        applies_to: draft.applies_to,
        replacement: draft.replacement || "[REDACTED]",
      });
      setDraft({ name: "", pattern: "", applies_to: ["all"], replacement: "[REDACTED]" });
      toast.success("Redaction rule saved");
      void load();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  const toggle = async (r: PiiRule) => {
    try { await adminTraces.updateRule(r.id, { enabled: !r.enabled }); void load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  const remove = async (r: PiiRule) => {
    if (!confirm(`Delete redaction rule "${r.name}"?`)) return;
    try { await adminTraces.deleteRule(r.id); toast.success("Deleted"); void load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between">
          <span>PII redaction rules ({rules.length})</span>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <div className="text-sm text-rose-600">{err}</div>}
        <p className="text-xs text-muted-foreground">
          Patterns are POSIX-compatible regex (case-insensitive, global). Applied at read-time to messages, hints,
          stack traces, URLs, user-agents, and every value in <code>fields</code>. The raw audit trail is preserved.
        </p>

        {/* Create */}
        <div className="rounded-md border border-dashed border-border p-3 space-y-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <Input placeholder="Name (e.g. Email addresses)"
              value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            <Input placeholder="Pattern (e.g. [\\w.-]+@[\\w.-]+)"
              className="font-mono text-sm"
              value={draft.pattern} onChange={(e) => setDraft((d) => ({ ...d, pattern: e.target.value }))} />
            <Input placeholder="Replacement (e.g. [email])"
              value={draft.replacement} onChange={(e) => setDraft((d) => ({ ...d, replacement: e.target.value }))} />
            <div className="flex flex-wrap gap-1 items-center">
              {APPLIES.map((a) => {
                const on = draft.applies_to.includes(a);
                return (
                  <Button key={a} size="sm" variant={on ? "default" : "outline"} type="button"
                    onClick={() => setDraft((d) => ({
                      ...d,
                      applies_to: on
                        ? d.applies_to.filter((x) => x !== a)
                        : a === "all" ? ["all"] : [...d.applies_to.filter((x) => x !== "all"), a],
                    }))}
                  >
                    {a}
                  </Button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void create()}>
              <Plus className="h-4 w-4 mr-1.5" /> Add rule
            </Button>
          </div>
        </div>

        {rules.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center">
            No rules yet. Exports and displayed traces will contain raw values.
          </div>
        )}
        <ul className="divide-y divide-border">
          {rules.map((r) => (
            <li key={r.id} className="py-2.5 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{r.name}</span>
                  {!r.enabled && <Badge variant="outline" className="text-xs">disabled</Badge>}
                  {r.applies_to.map((a) => <Badge key={a} variant="secondary" className="text-[10px]">{a}</Badge>)}
                </div>
                <div className="text-xs font-mono text-muted-foreground truncate mt-0.5">/{r.pattern}/gi → {r.replacement}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void toggle(r)}>
                <Save className="h-3.5 w-3.5 mr-1" /> {r.enabled ? "Disable" : "Enable"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void remove(r)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// -------------------------------------------------------------- Webhooks
function WebhooksCard() {
  const [hooks, setHooks] = useState<AlertWebhook[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", url: "", secret: "", tag_filter: "" });

  const load = useCallback(async () => {
    if (!isLive()) { setErr("Live backend not configured."); return; }
    setLoading(true); setErr(null);
    try { const r = await adminTraces.listWebhooks(); setHooks(r.webhooks); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!draft.name.trim() || !draft.url.trim()) { toast.error("Name and URL required"); return; }
    try {
      await adminTraces.createWebhook({
        name: draft.name.trim(),
        url: draft.url.trim(),
        secret: draft.secret.trim() || null,
        tag_filter: draft.tag_filter.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setDraft({ name: "", url: "", secret: "", tag_filter: "" });
      toast.success("Webhook saved");
      void load();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  const toggle = async (h: AlertWebhook) => {
    try { await adminTraces.updateWebhook(h.id, { enabled: !h.enabled }); void load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  const remove = async (h: AlertWebhook) => {
    if (!confirm(`Delete webhook "${h.name}"?`)) return;
    try { await adminTraces.deleteWebhook(h.id); toast.success("Deleted"); void load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  const test = async (h: AlertWebhook) => {
    try {
      const r = await adminTraces.testWebhook(h.id);
      if (r.ok) toast.success(`Delivered (HTTP ${r.status ?? "?"})`);
      else toast.error(`Failed: ${r.error ?? `HTTP ${r.status ?? "?"}`}`);
      void load();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between">
          <span>Alert webhooks ({hooks.length})</span>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && <div className="text-sm text-rose-600">{err}</div>}
        <p className="text-xs text-muted-foreground">
          Receives <code>alert=true</code> spike events with traceId samples and deep-links back into the trace viewer.
          If a secret is set, requests carry an <code>x-pluto-signature: sha256=&lt;hmac&gt;</code> header of the raw JSON body.
          Leave <em>tag filter</em> empty to receive every alert.
        </p>

        <div className="rounded-md border border-dashed border-border p-3 space-y-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <Input placeholder="Name (e.g. Slack #alerts)"
              value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            <Input placeholder="https://hooks.example.com/..."
              value={draft.url} onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))} />
            <Input placeholder="Signing secret (optional, min 8 chars)"
              type="password"
              value={draft.secret} onChange={(e) => setDraft((d) => ({ ...d, secret: e.target.value }))} />
            <Input placeholder="Tag filter (comma-separated, blank = all)"
              className="font-mono text-sm"
              value={draft.tag_filter} onChange={(e) => setDraft((d) => ({ ...d, tag_filter: e.target.value }))} />
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void create()}>
              <Plus className="h-4 w-4 mr-1.5" /> Add webhook
            </Button>
          </div>
        </div>

        {hooks.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center">
            No webhooks configured. Spike alerts will only appear in server logs.
          </div>
        )}
        <ul className="divide-y divide-border">
          {hooks.map((h) => (
            <li key={h.id} className="py-2.5 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{h.name}</span>
                  {!h.enabled && <Badge variant="outline" className="text-xs">disabled</Badge>}
                  {h.has_secret && <Badge variant="secondary" className="text-[10px]">signed</Badge>}
                  {h.tag_filter.length === 0
                    ? <Badge variant="outline" className="text-[10px]">all tags</Badge>
                    : h.tag_filter.map((t) => <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>)}
                  {h.failure_count > 0 && (
                    <Badge variant="outline" className="text-[10px] bg-rose-500/10 text-rose-600 border-rose-500/30">
                      {h.failure_count} recent failures
                    </Badge>
                  )}
                </div>
                <div className="text-xs font-mono text-muted-foreground truncate mt-0.5">{h.url}</div>
                {h.last_delivery_at && (
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    Last: {new Date(h.last_delivery_at).toLocaleString()}
                    {h.last_status != null && ` · HTTP ${h.last_status}`}
                    {h.last_error && ` · ${h.last_error}`}
                  </div>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => void test(h)}>
                <Send className="h-3.5 w-3.5 mr-1" /> Test
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void toggle(h)}>
                <Save className="h-3.5 w-3.5 mr-1" /> {h.enabled ? "Disable" : "Enable"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void remove(h)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
