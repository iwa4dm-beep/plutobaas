import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Send, Copy, Check } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";
import { AdminGate } from "@/components/AdminGate";
import { isLive, live, type InviteResult } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/admin/invite")({
  head: () => ({
    meta: [
      { title: "Invite a customer — Pluto" },
      { name: "description", content: "Create a workspace + keys for a new customer and email them an invite link." },
    ],
  }),
  component: () => <AdminGate><InvitePage /></AdminGate>,
});

function InvitePage() {
  const [email, setEmail] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [result, setResult] = useState<InviteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await live.admin.invite(email, workspaceName);
      setResult(r);
      setEmail(""); setWorkspaceName("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Invite a customer"
        description="We will create a workspace + project + API keys and email the customer an invite link they can use to set their password."
      />
      <AutoHelpPanel slug={'dashboard.admin.invite'} title={'Invite a customer'} description={'We will create a workspace + project + API keys and email the customer an invite link they can use to set their password.'} />

      {!isLive() && (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Live backend not configured.
        </div>
      )}

      <form onSubmit={onSubmit} className="rounded-lg border p-4 space-y-3 max-w-lg">
        <Field label="Customer email">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="customer@example.com"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </Field>
        <Field label="Workspace name">
          <input required minLength={2} maxLength={80} value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)} placeholder="Acme Inc"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </Field>
        {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{err}</div>}
        <button type="submit" disabled={busy || !isLive()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
          <Send className="h-3.5 w-3.5" /> {busy ? "Sending…" : "Send invite"}
        </button>
      </form>

      {result && (
        <div className="rounded-lg border bg-card p-4 max-w-lg">
          <h3 className="font-medium mb-2">Invite created ✅</h3>
          <p className="text-sm text-muted-foreground mb-3">
            Workspace <b>{result.workspace.name}</b> is ready. An email has been queued. You can also share this link manually:
          </p>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
            <span className="flex-1 truncate">{result.invite_link}</span>
            <button onClick={() => { navigator.clipboard.writeText(result.invite_link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="text-muted-foreground hover:text-foreground">
              {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">Expires: {new Date(result.expires_at).toLocaleString()}</p>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}
