import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Globe2, Loader2, Plus, RefreshCw, ShieldCheck, Star, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";
import { enterprise, isLive, type CustomDomain } from "@/lib/pluto/live";
import { useWorkspace } from "@/lib/pluto/workspace-context";
import {
  getWorkspaceBaseUrl,
  resolveApiUrl,
  resolveDashboardUrl,
  setWorkspaceBaseUrl,
} from "@/lib/pluto/base-url";

export const Route = createFileRoute("/dashboard/custom-domains")({
  head: () => ({
    meta: [
      { title: "Custom domains — Pluto" },
      { name: "description", content: "Attach your own hostname to a workspace and serve the API from it." },
    ],
  }),
  component: CustomDomainsPage,
});

type AddedRecord = { dns_txt_record: string; dns_txt_value: string; hostname: string };

function CustomDomainsPage() {
  const { active } = useWorkspace();
  const workspaceId = active?.id ?? "root";

  const [items, setItems] = useState<CustomDomain[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [added, setAdded] = useState<AddedRecord | null>(null);
  const [primary, setPrimaryState] = useState<string | null>(() =>
    getWorkspaceBaseUrl(workspaceId),
  );

  const load = useCallback(async () => {
    setErr(null);
    if (!isLive()) {
      setItems([]);
      setErr(new Error("Backend not configured. Set VITE_PLUTO_URL and VITE_PLUTO_SERVICE_KEY."));
      return;
    }
    try {
      const { domains } = await enterprise.domains();
      setItems(domains);
    } catch (e) {
      setErr(e);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-poll while any domain is still pending verification / cert issuance.
  useEffect(() => {
    if (!items || items.length === 0) return;
    const pending = items.some((d) => !d.verified || (d.cert_status && d.cert_status !== "issued"));
    if (!pending) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [items, load]);

  async function add() {
    const host = hostname.trim().toLowerCase();
    if (!isValidHostname(host)) {
      setErr(new Error("Enter a valid hostname like api.example.com (no scheme, no path)."));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await enterprise.addDomain(host);
      setAdded({ dns_txt_record: r.dns_txt_record, dns_txt_value: r.dns_txt_value, hostname: r.hostname });
      setHostname("");
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function verify(id: string) {
    setVerifyingId(id);
    try {
      await enterprise.verifyDomain(id);
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setVerifyingId(null);
    }
  }

  async function remove(d: CustomDomain) {
    if (!confirm(`Remove ${d.hostname}? Requests to it will stop working immediately.`)) return;
    try {
      await enterprise.removeDomain(d.id);
      if (primary === `https://${d.hostname}`) {
        setWorkspaceBaseUrl(workspaceId, null);
        setPrimaryState(null);
      }
      await load();
    } catch (e) {
      setErr(e);
    }
  }

  function makePrimary(d: CustomDomain) {
    if (!d.verified) return;
    const url = `https://${d.hostname}`;
    setWorkspaceBaseUrl(workspaceId, url);
    setPrimaryState(url);
  }

  function clearPrimary() {
    setWorkspaceBaseUrl(workspaceId, null);
    setPrimaryState(null);
  }

  const effectiveUrl = useMemo(() => resolveApiUrl(workspaceId), [workspaceId, primary]);
  const dashboardUrl = useMemo(() => resolveDashboardUrl(), []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Custom domains"
        description="Serve your Pluto API from your own hostname (e.g. api.yourbrand.com). Add the DNS records we generate, then click Verify."
      />
      <AutoHelpPanel
        slug="dashboard.custom-domains"
        title="Custom domains"
        description="Attach a hostname you own to this workspace. We issue a TLS certificate automatically once the DNS TXT record is verified."
      />

      <ErrorBanner error={err} onRetry={() => void load()} onDismiss={() => setErr(null)} />

      {/* Effective endpoint summary */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3 text-sm font-medium">
          <ShieldCheck className="h-4 w-4" /> Effective public endpoint for this workspace
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <UrlPanel label="API base URL" value={effectiveUrl} />
          <UrlPanel label="Dashboard URL" value={dashboardUrl} />
        </div>
        {primary && (
          <p className="mt-3 text-xs text-muted-foreground">
            Using custom domain <code className="font-mono">{primary}</code> as the primary API URL for this workspace.{" "}
            <button className="underline hover:text-foreground" onClick={clearPrimary}>Reset to default</button>
          </p>
        )}
      </section>

      {/* Add new domain */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3 text-sm font-medium">
          <Globe2 className="h-4 w-4" /> Attach a new hostname
        </div>
        <div className="grid gap-2 md:grid-cols-[1fr_auto]">
          <input
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="api.yourbrand.com"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          />
          <button
            onClick={() => void add()}
            disabled={busy || !hostname.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add domain
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Hostname only — no <code>https://</code>, no path. Wildcards are not supported.
        </p>
      </section>

      {added && <DnsInstructions record={added} onClose={() => setAdded(null)} />}

      {/* List */}
      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-2 flex items-center justify-between">
          <div className="text-sm font-medium">Registered domains</div>
          <button
            onClick={() => void load()}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-2">Hostname</th>
              <th className="text-left px-4 py-2">Verified</th>
              <th className="text-left px-4 py-2">Certificate</th>
              <th className="text-left px-4 py-2">Added</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items === null && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-muted-foreground">Loading…</td></tr>
            )}
            {items && items.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-muted-foreground">
                No custom domains yet. Add one above.
              </td></tr>
            )}
            {items?.map((d) => {
              const isPrimary = primary === `https://${d.hostname}`;
              return (
                <tr key={d.id} className="border-t border-border align-middle">
                  <td className="px-4 py-2 font-mono text-xs">
                    {d.hostname}
                    {isPrimary && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                        <Star className="h-3 w-3" /> primary
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {d.verified ? (
                      <span className="inline-flex items-center gap-1 text-emerald-300 text-xs"><Check className="h-3.5 w-3.5" /> verified</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-300 text-xs"><X className="h-3.5 w-3.5" /> pending</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <CertBadge status={d.cert_status} />
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{new Date(d.created_at).toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex gap-1">
                      {!d.verified && (
                        <button
                          onClick={() => void verify(d.id)}
                          disabled={verifyingId === d.id}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                        >
                          {verifyingId === d.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <ShieldCheck className="h-3.5 w-3.5" />}
                          Verify
                        </button>
                      )}
                      {d.verified && !isPrimary && (
                        <button
                          onClick={() => makePrimary(d)}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                        >
                          <Star className="h-3.5 w-3.5" /> Make primary
                        </button>
                      )}
                      {!d.verified && (
                        <button
                          onClick={() => setAdded({
                            hostname: d.hostname,
                            dns_txt_record: `_pluto-verify.${d.hostname}`,
                            dns_txt_value: d.verify_token,
                          })}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                        >
                          DNS
                        </button>
                      )}
                      <button
                        onClick={() => void remove(d)}
                        className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function CertBadge({ status }: { status: string | null | undefined }) {
  const s = (status ?? "pending").toLowerCase();
  const tone =
    s === "issued" ? "bg-emerald-500/15 text-emerald-300"
    : s === "failed" ? "bg-red-500/15 text-red-300"
    : "bg-amber-500/15 text-amber-300";
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] uppercase ${tone}`}>{s}</span>;
}

function UrlPanel({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-[11px] uppercase text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-muted px-2 py-1.5 font-mono text-[11px] break-all">{value || "—"}</code>
        <button
          onClick={() => {
            if (!value) return;
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent"
          title="Copy"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function DnsInstructions({ record, onClose }: { record: AddedRecord; onClose: () => void }) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-amber-200">Add this DNS record to verify {record.hostname}</div>
        <button onClick={onClose} className="rounded-md p-1 hover:bg-amber-500/10"><X className="h-4 w-4" /></button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        In your DNS provider, add the TXT record below. Then create a CNAME/A record pointing
        <code className="mx-1 font-mono">{record.hostname}</code> at the same host your Pluto backend
        answers on. Once DNS propagates (usually 1–30 min), click <b>Verify</b>.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Type" value="TXT" />
        <Field label="Name" value={record.dns_txt_record} />
        <Field label="Value" value={record.dns_txt_value} />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-muted-foreground mb-1">{label}</div>
      <code className="block rounded bg-muted px-2 py-1.5 font-mono text-[11px] break-all">{value}</code>
    </div>
  );
}

function isValidHostname(h: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h);
}
