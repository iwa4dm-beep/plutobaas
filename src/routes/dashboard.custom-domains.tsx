import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Check,
  Copy,
  Globe2,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Star,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";
import { enterprise, isLive, live, type CustomDomain } from "@/lib/pluto/live";
import { useWorkspace } from "@/lib/pluto/workspace-context";
import { useAuth } from "@/lib/pluto/auth-context";
import {
  getWorkspaceBaseUrl,
  resolveApiUrl,
  resolveDashboardUrl,
  setWorkspaceBaseUrl,
} from "@/lib/pluto/base-url";
import { recordDomainAudit } from "@/lib/pluto/domain-audit";
import {
  isWildcardHostname,
  testDomainEndpoint,
  verifyTxtRecordName,
  type DomainTestResult,
} from "@/lib/pluto/domain-test";

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
  const { session } = useAuth();
  const workspaceId = active?.id ?? "root";
  const actor = session?.user?.email ?? session?.user?.id ?? "anonymous";

  const [items, setItems] = useState<CustomDomain[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<DomainTestResult | null>(null);
  const [added, setAdded] = useState<AddedRecord | null>(null);
  const [primary, setPrimaryState] = useState<string | null>(() =>
    getWorkspaceBaseUrl(workspaceId),
  );
  const [rtStatus, setRtStatus] = useState<"idle" | "connecting" | "open" | "closed" | "polling">("idle");

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

  useEffect(() => { void load(); }, [load]);

  // Realtime: subscribe to workspace-scoped domain-status channel; fall back to polling.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!isLive()) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;

    const startPolling = () => {
      if (pollRef.current) return;
      setRtStatus("polling");
      pollRef.current = setInterval(() => void load(), 3_000);
    };
    const stopPolling = () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };

    try {
      setRtStatus("connecting");
      unsub = live.realtime.subscribe(
        `custom_domains:${workspaceId}`,
        () => { void load(); },
        {
          onStatus: (s) => {
            if (cancelled) return;
            if (s === "open") { stopPolling(); setRtStatus("open"); }
            else if (s === "closed" || s === "error") { setRtStatus("closed"); startPolling(); }
          },
        },
      );
    } catch {
      startPolling();
    }

    // Also keep a slow fallback poll in case webhook/realtime is silent.
    const slow = setInterval(() => {
      if (rtStatus !== "open") void load();
    }, 20_000);

    return () => {
      cancelled = true;
      stopPolling();
      clearInterval(slow);
      try { unsub?.(); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, load]);

  async function add() {
    const host = hostname.trim().toLowerCase();
    if (!isValidHostname(host)) {
      setErr(new Error("Enter a valid hostname like api.example.com or *.tenants.example.com (no scheme, no path)."));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await enterprise.addDomain(host);
      setAdded({ dns_txt_record: r.dns_txt_record, dns_txt_value: r.dns_txt_value, hostname: r.hostname });
      recordDomainAudit(workspaceId, actor, "domain.add", host, "ok", { wildcard: isWildcardHostname(host) });
      setHostname("");
      await load();
    } catch (e) {
      recordDomainAudit(workspaceId, actor, "domain.add", host, "error", { message: (e as Error).message });
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function verify(d: CustomDomain) {
    setVerifyingId(d.id);
    try {
      await enterprise.verifyDomain(d.id);
      recordDomainAudit(workspaceId, actor, "domain.verify", d.hostname, "ok");
      await load();
    } catch (e) {
      recordDomainAudit(workspaceId, actor, "domain.verify", d.hostname, "error", { message: (e as Error).message });
      setErr(e);
    } finally {
      setVerifyingId(null);
    }
  }

  async function remove(d: CustomDomain) {
    if (!confirm(`Remove ${d.hostname}? Requests to it will stop working immediately.`)) return;
    try {
      await enterprise.removeDomain(d.id);
      recordDomainAudit(workspaceId, actor, "domain.remove", d.hostname, "ok");
      if (primary === `https://${d.hostname}`) {
        setWorkspaceBaseUrl(workspaceId, null);
        setPrimaryState(null);
      }
      await load();
    } catch (e) {
      recordDomainAudit(workspaceId, actor, "domain.remove", d.hostname, "error", { message: (e as Error).message });
      setErr(e);
    }
  }

  async function runTest(d: CustomDomain) {
    setTestingId(d.id);
    setTestResult(null);
    try {
      const r = await testDomainEndpoint(d.hostname, d.verify_token);
      setTestResult(r);
      recordDomainAudit(workspaceId, actor, "domain.test_endpoint", d.hostname, r.health.ok && r.verifyTxt.found ? "ok" : "error", {
        health_status: r.health.status,
        health_ok: r.health.ok,
        dns_a: r.dns.a.length,
        dns_cname: r.dns.cname.length,
        verify_txt_found: r.verifyTxt.found,
      });
    } catch (e) {
      recordDomainAudit(workspaceId, actor, "domain.test_endpoint", d.hostname, "error", { message: (e as Error).message });
      setErr(e);
    } finally {
      setTestingId(null);
    }
  }

  function makePrimary(d: CustomDomain) {
    if (!d.verified) return;
    if (isWildcardHostname(d.hostname)) {
      setErr(new Error("Wildcard domains cannot be the primary API URL — pick a concrete hostname."));
      return;
    }
    const url = `https://${d.hostname}`;
    setWorkspaceBaseUrl(workspaceId, url);
    setPrimaryState(url);
    recordDomainAudit(workspaceId, actor, "domain.make_primary", d.hostname, "ok");
  }

  function clearPrimary() {
    const prev = primary;
    setWorkspaceBaseUrl(workspaceId, null);
    setPrimaryState(null);
    recordDomainAudit(workspaceId, actor, "domain.clear_primary", prev ?? "", "ok");
  }

  const effectiveUrl = useMemo(() => resolveApiUrl(workspaceId), [workspaceId, primary]);
  const dashboardUrl = useMemo(() => resolveDashboardUrl(), []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Custom domains"
        description="Serve your Pluto API from your own hostname (e.g. api.yourbrand.com, or *.tenants.yourbrand.com for multi-tenant subdomains). Add the DNS records we generate, then click Verify."
      />
      <AutoHelpPanel
        slug="dashboard.custom-domains"
        title="Custom domains"
        description="Attach a hostname or wildcard you own to this workspace. We issue a TLS certificate automatically once the DNS record is verified — status updates arrive in real time from the backend."
      />

      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <Radio className={`h-3.5 w-3.5 ${rtStatus === "open" ? "text-emerald-400 animate-pulse" : rtStatus === "polling" ? "text-amber-400" : ""}`} />
          {rtStatus === "open" && "Realtime updates streaming"}
          {rtStatus === "connecting" && "Connecting to realtime channel…"}
          {rtStatus === "polling" && "Polling every 3s (realtime unavailable)"}
          {rtStatus === "closed" && "Realtime disconnected — polling"}
          {rtStatus === "idle" && "Idle"}
        </div>
        <Link
          to="/dashboard/custom-domains/audit"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
        >
          <ScrollText className="h-3.5 w-3.5" /> Audit log
        </Link>
      </div>

      <ErrorBanner error={err} onRetry={() => void load()} onDismiss={() => setErr(null)} />

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

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3 text-sm font-medium">
          <Globe2 className="h-4 w-4" /> Attach a new hostname
        </div>
        <div className="grid gap-2 md:grid-cols-[1fr_auto]">
          <input
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="api.yourbrand.com  ·  or  *.tenants.yourbrand.com"
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
          Hostname only — no <code>https://</code>, no path. Wildcards like <code>*.tenants.example.com</code> map every subdomain
          to this workspace (multi-tenant). Wildcard certs are issued via ACME DNS-01 (Let's Encrypt).
        </p>
      </section>

      {added && <DnsInstructions record={added} onClose={() => setAdded(null)} />}

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
              <th className="text-left px-4 py-2">Type</th>
              <th className="text-left px-4 py-2">Verified</th>
              <th className="text-left px-4 py-2">Certificate</th>
              <th className="text-left px-4 py-2">Added</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items === null && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-muted-foreground">Loading…</td></tr>
            )}
            {items && items.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-xs text-muted-foreground">
                No custom domains yet. Add one above.
              </td></tr>
            )}
            {items?.map((d) => {
              const wildcard = isWildcardHostname(d.hostname);
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
                    {wildcard ? (
                      <span className="inline-flex items-center gap-1 rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] uppercase text-purple-300">
                        <Wand2 className="h-3 w-3" /> wildcard
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase text-muted-foreground">host</span>
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
                      <button
                        onClick={() => void runTest(d)}
                        disabled={testingId === d.id}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                        title="Check DNS + healthcheck without changing config"
                      >
                        {testingId === d.id
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Activity className="h-3.5 w-3.5" />}
                        Test endpoint
                      </button>
                      {!d.verified && (
                        <button
                          onClick={() => void verify(d)}
                          disabled={verifyingId === d.id}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                        >
                          {verifyingId === d.id
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <ShieldCheck className="h-3.5 w-3.5" />}
                          Verify
                        </button>
                      )}
                      {d.verified && !isPrimary && !wildcard && (
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
                            dns_txt_record: verifyTxtRecordName(d.hostname),
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

      {testResult && (
        <TestResultPanel result={testResult} onClose={() => setTestResult(null)} />
      )}
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
  const wildcard = isWildcardHostname(record.hostname);
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-amber-200">
          {wildcard
            ? `Add DNS records to verify wildcard ${record.hostname}`
            : `Add this DNS record to verify ${record.hostname}`}
        </div>
        <button onClick={onClose} className="rounded-md p-1 hover:bg-amber-500/10"><X className="h-4 w-4" /></button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        In your DNS provider, add the TXT record below.{" "}
        {wildcard ? (
          <>Then create a wildcard <code className="mx-1 font-mono">A</code> record for{" "}
            <code className="mx-1 font-mono">{record.hostname}</code> pointing at your Pluto backend IP. We issue
            wildcard TLS via ACME DNS-01.</>
        ) : (
          <>Then create a CNAME/A record pointing{" "}
            <code className="mx-1 font-mono">{record.hostname}</code> at the same host your Pluto backend answers on.</>
        )}{" "}
        Once DNS propagates (usually 1–30 min), click <b>Verify</b>.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Type" value="TXT" />
        <Field label="Name" value={record.dns_txt_record} />
        <Field label="Value" value={record.dns_txt_value} />
      </div>
    </div>
  );
}

function TestResultPanel({ result, onClose }: { result: DomainTestResult; onClose: () => void }) {
  const overallOk = result.health.ok && result.verifyTxt.found;
  return (
    <section className={`rounded-lg border p-4 ${overallOk ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5"}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">
          Test result for <code className="font-mono">{result.hostname}</code>
          {result.isWildcard && <span className="ml-2 text-[10px] uppercase text-purple-300">wildcard</span>}
        </div>
        <button onClick={onClose} className="rounded-md p-1 hover:bg-muted"><X className="h-4 w-4" /></button>
      </div>
      <div className="grid gap-4 md:grid-cols-3 text-xs">
        <div>
          <div className="uppercase text-muted-foreground mb-1">DNS · A/AAAA/CNAME</div>
          <ul className="space-y-1 font-mono">
            {result.dns.a.map((r, i) => <li key={"a" + i}>A → {r.data}</li>)}
            {result.dns.aaaa.map((r, i) => <li key={"aa" + i}>AAAA → {r.data}</li>)}
            {result.dns.cname.map((r, i) => <li key={"c" + i}>CNAME → {r.data}</li>)}
            {result.dns.a.length + result.dns.aaaa.length + result.dns.cname.length === 0 && (
              <li className="text-red-300">No A/AAAA/CNAME records found.</li>
            )}
          </ul>
        </div>
        <div>
          <div className="uppercase text-muted-foreground mb-1">Verify TXT</div>
          <div className="font-mono break-all">{result.verifyTxt.expectedName}</div>
          {result.verifyTxt.found ? (
            <div className="mt-1 text-emerald-300">✓ Expected value found</div>
          ) : (
            <div className="mt-1 text-red-300">
              ✗ Not found. {result.verifyTxt.values.length > 0 && `Saw: ${result.verifyTxt.values.join(", ")}`}
            </div>
          )}
        </div>
        <div>
          <div className="uppercase text-muted-foreground mb-1">Healthcheck</div>
          <div className="font-mono break-all">{result.health.url}</div>
          {result.health.ok ? (
            <div className="mt-1 text-emerald-300">
              ✓ {result.health.status ?? "reachable"} · {result.health.ms}ms
              {result.health.error && ` (${result.health.error})`}
            </div>
          ) : (
            <div className="mt-1 text-red-300">✗ {result.health.error ?? "unreachable"} · {result.health.ms}ms</div>
          )}
        </div>
      </div>
      {!overallOk && (
        <p className="mt-3 text-xs text-muted-foreground">
          Fix DNS or reachability before making this domain primary — the frontend will start signing SDK calls against it
          the moment you promote it.
        </p>
      )}
    </section>
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
  // Allow wildcard prefix `*.` for multi-tenant subdomain mappings.
  const bare = h.startsWith("*.") ? h.slice(2) : h;
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(bare);
}
