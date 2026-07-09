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
  StopCircle,
} from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { HelpPanel } from "@/components/help/HelpPanel";
import { dashboardCustomDomainsHelp } from "@/content/help/dashboard.custom-domains";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";
import { enterprise, isLive, live, me, type CustomDomain } from "@/lib/pluto/live";
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
import { retryWithBackoff, type RetryAttempt } from "@/lib/pluto/retry-backoff";

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
  const [primaryPending, setPrimaryPending] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<DomainTestResult | null>(null);
  const [added, setAdded] = useState<AddedRecord | null>(null);
  // Retry / backoff state — keyed by "<op>:<domain_id>" so verify and test can run in parallel per row.
  const [retryState, setRetryState] = useState<Record<string, RetryAttempt>>({});
  const abortersRef = useRef<Record<string, AbortController>>({});
  const [primary, setPrimaryState] = useState<string | null>(() =>
    getWorkspaceBaseUrl(workspaceId),
  );
  const [rtStatus, setRtStatus] = useState<"idle" | "connecting" | "open" | "closed" | "polling">("idle");
  const [role, setRole] = useState<"loading" | "workspace_admin" | "domain_admin" | "member">("loading");
  const canAdmin = role === "workspace_admin" || role === "domain_admin";
  const canManageAdmins = role === "workspace_admin";

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
      // Sync base-url override with backend's authoritative is_primary flag
      // so SDK snippets always reflect the workspace's current primary.
      const backendPrimary = domains.find((d) => d.is_primary);
      if (backendPrimary) {
        const url = `https://${backendPrimary.hostname}`;
        setWorkspaceBaseUrl(workspaceId, url);
        setPrimaryState(url);
      } else if (primary && !domains.some((d) => `https://${d.hostname}` === primary)) {
        // Stored primary no longer maps to any registered domain — clear it.
        setWorkspaceBaseUrl(workspaceId, null);
        setPrimaryState(null);
      }
    } catch (e) {
      setErr(e);
      setItems([]);
    }
  }, [workspaceId, primary]);

  // Resolve caller's effective role in this workspace.
  useEffect(() => {
    if (!isLive()) { setRole("member"); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await me.workspaceRole();
        if (cancelled) return;
        if (r.can_admin) setRole("workspace_admin");
        else if (r.is_domain_admin) setRole("domain_admin");
        else setRole("member");
      } catch {
        if (!cancelled) setRole("member");
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

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
            if (s.kind === "open") { stopPolling(); setRtStatus("open"); }
            else if (s.kind === "closed" || s.kind === "auth_error") { setRtStatus("closed"); startPolling(); }
            else if (s.kind === "connecting") { setRtStatus("connecting"); }
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

  function cancelRetry(key: string) {
    const c = abortersRef.current[key];
    if (c) { c.abort(); delete abortersRef.current[key]; }
    setRetryState((s) => { const next = { ...s }; delete next[key]; return next; });
  }

  async function verify(d: CustomDomain, opts: { retry?: boolean } = {}) {
    const key = `verify:${d.id}`;
    cancelRetry(key);
    const ctrl = new AbortController();
    abortersRef.current[key] = ctrl;
    setVerifyingId(d.id);
    try {
      const runOnce = () => enterprise.verifyDomain(d.id).then((r) => {
        // The backend returns `{ ok, verified }`; treat "not yet verified" as retryable.
        if (opts.retry && r && r.verified === false) throw new Error("txt_not_yet_visible");
        return r;
      });
      const res = opts.retry
        ? await retryWithBackoff(runOnce, {
            maxAttempts: 5,
            signal: ctrl.signal,
            onAttempt: (a) => setRetryState((s) => ({ ...s, [key]: a })),
            shouldRetry: (e) => (e as Error).name !== "AbortError",
          })
        : await runOnce();
      recordDomainAudit(workspaceId, actor, "domain.verify", d.hostname, "ok", opts.retry ? { retry: true } : {});
      await load();
      return res;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      recordDomainAudit(workspaceId, actor, "domain.verify", d.hostname, "error",
        { message: (e as Error).message, retry: opts.retry ?? false });
      setErr(e);
    } finally {
      setVerifyingId((cur) => (cur === d.id ? null : cur));
      delete abortersRef.current[key];
      setRetryState((s) => { const next = { ...s }; delete next[key]; return next; });
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

  async function runTest(d: CustomDomain, opts: { retry?: boolean } = {}) {
    const key = `test:${d.id}`;
    cancelRetry(key);
    const ctrl = new AbortController();
    abortersRef.current[key] = ctrl;
    setTestingId(d.id);
    setTestResult(null);
    try {
      const runOnce = async () => {
        const r = await testDomainEndpoint(d.hostname, d.verify_token);
        // Treat "DNS not yet propagated OR health failing" as retryable when retry mode is on.
        if (opts.retry && !(r.health.ok && r.verifyTxt.found)) {
          throw Object.assign(new Error("endpoint_not_ready"), { partial: r });
        }
        return r;
      };
      const r = opts.retry
        ? await retryWithBackoff(runOnce, {
            maxAttempts: 5,
            signal: ctrl.signal,
            onAttempt: (a) => setRetryState((s) => ({ ...s, [key]: a })),
            shouldRetry: (e) => (e as Error).name !== "AbortError",
          })
        : await runOnce();
      setTestResult(r);
      recordDomainAudit(workspaceId, actor, "domain.test_endpoint", d.hostname,
        r.health.ok && r.verifyTxt.found ? "ok" : "error", {
          health_status: r.health.status,
          health_ok: r.health.ok,
          dns_a: r.dns.a.length,
          dns_cname: r.dns.cname.length,
          verify_txt_found: r.verifyTxt.found,
          retry: opts.retry ?? false,
        });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // Surface last partial result if the retry loop gave up.
      const partial = (e as { partial?: DomainTestResult }).partial;
      if (partial) setTestResult(partial);
      recordDomainAudit(workspaceId, actor, "domain.test_endpoint", d.hostname, "error",
        { message: (e as Error).message, retry: opts.retry ?? false });
      setErr(e);
    } finally {
      setTestingId((cur) => (cur === d.id ? null : cur));
      delete abortersRef.current[key];
      setRetryState((s) => { const next = { ...s }; delete next[key]; return next; });
    }
  }

  async function makePrimary(d: CustomDomain) {
    if (!d.verified) return;
    if (isWildcardHostname(d.hostname)) {
      setErr(new Error("Wildcard domains cannot be the primary API URL — pick a concrete hostname."));
      return;
    }
    setPrimaryPending(d.id);
    try {
      await enterprise.setPrimaryDomain(d.id);
      const url = `https://${d.hostname}`;
      setWorkspaceBaseUrl(workspaceId, url);
      setPrimaryState(url);
      recordDomainAudit(workspaceId, actor, "domain.make_primary", d.hostname, "ok");
      await load();
    } catch (e) {
      recordDomainAudit(workspaceId, actor, "domain.make_primary", d.hostname, "error", { message: (e as Error).message });
      setErr(e);
    } finally {
      setPrimaryPending(null);
    }
  }

  async function clearPrimary() {
    const current = items?.find((d) => d.is_primary);
    setPrimaryPending(current?.id ?? "clear");
    try {
      if (current) await enterprise.clearPrimaryDomain(current.id);
      const prev = primary;
      setWorkspaceBaseUrl(workspaceId, null);
      setPrimaryState(null);
      recordDomainAudit(workspaceId, actor, "domain.clear_primary", current?.hostname ?? prev ?? "", "ok");
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setPrimaryPending(null);
    }
  }

  const effectiveUrl = useMemo(() => resolveApiUrl(workspaceId), [workspaceId, primary]);
  const dashboardUrl = useMemo(() => resolveDashboardUrl(), []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Custom domains"
        description="Serve your Pluto API from your own hostname (e.g. api.yourbrand.com, or *.tenants.yourbrand.com for multi-tenant subdomains). Add the DNS records we generate, then click Verify."
      />
      <HelpPanel help={dashboardCustomDomainsHelp} />

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

      {!canAdmin && role !== "loading" && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-200">
          You are signed in as a workspace <b>member</b>. Only workspace <b>owners/admins</b> or users granted the
          <b> domain-admin</b> permission can add, verify, make primary, or remove custom domains. Read-only view enabled.
        </div>
      )}
      {role === "domain_admin" && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs text-emerald-200">
          You have the <b>domain-admin</b> permission on this workspace — you can manage custom domains without full workspace-admin rights.
        </div>
      )}

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
            disabled={!canAdmin}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm font-mono disabled:opacity-50"
            onKeyDown={(e) => { if (e.key === "Enter" && canAdmin) void add(); }}
          />
          <button
            onClick={() => void add()}
            disabled={!canAdmin || busy || !hostname.trim()}
            title={!canAdmin ? "Workspace admin role required" : undefined}
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
              const isPrimary = Boolean(d.is_primary) || primary === `https://${d.hostname}`;
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
                    <div className="inline-flex flex-col items-end gap-1">
                      <div className="inline-flex gap-1 flex-wrap justify-end">
                        <button
                          onClick={() => void runTest(d)}
                          disabled={testingId === d.id}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                          title="Check DNS + healthcheck once"
                        >
                          {testingId === d.id && !retryState[`test:${d.id}`]
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Activity className="h-3.5 w-3.5" />}
                          Test
                        </button>
                        <button
                          onClick={() => void runTest(d, { retry: true })}
                          disabled={testingId === d.id}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                          title="Retry test up to 5× with exponential backoff (1s → 16s)"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${retryState[`test:${d.id}`] ? "animate-spin" : ""}`} />
                          Retry test
                        </button>
                        {!d.verified && (
                          <>
                            <button
                              onClick={() => void verify(d)}
                              disabled={!canAdmin || verifyingId === d.id}
                              title={!canAdmin ? "Workspace admin role required" : undefined}
                              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                            >
                              {verifyingId === d.id && !retryState[`verify:${d.id}`]
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <ShieldCheck className="h-3.5 w-3.5" />}
                              Verify
                            </button>
                            <button
                              onClick={() => void verify(d, { retry: true })}
                              disabled={!canAdmin || verifyingId === d.id}
                              title={!canAdmin
                                ? "Workspace admin role required"
                                : "Retry verify up to 5× with exponential backoff"}
                              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                            >
                              <RefreshCw className={`h-3.5 w-3.5 ${retryState[`verify:${d.id}`] ? "animate-spin" : ""}`} />
                              Retry verify
                            </button>
                          </>
                        )}
                        {d.verified && !isPrimary && !wildcard && (
                          <button
                            onClick={() => void makePrimary(d)}
                            disabled={!canAdmin || primaryPending === d.id}
                            title={!canAdmin ? "Workspace admin role required" : undefined}
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                          >
                            {primaryPending === d.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Star className="h-3.5 w-3.5" />}
                            Make primary
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
                          disabled={!canAdmin}
                          title={!canAdmin ? "Workspace admin role required" : undefined}
                          className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-40"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <RetryStatus
                        attempt={retryState[`verify:${d.id}`]}
                        label="Verify"
                        onCancel={() => cancelRetry(`verify:${d.id}`)}
                      />
                      <RetryStatus
                        attempt={retryState[`test:${d.id}`]}
                        label="Test"
                        onCancel={() => cancelRetry(`test:${d.id}`)}
                      />
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

      <DomainAdminsSection
        workspaceId={workspaceId}
        actor={actor}
        canManage={canManageAdmins}
        canRead={role !== "loading"}
      />
    </div>
  );
}

function DomainAdminsSection({
  workspaceId, actor, canManage, canRead,
}: { workspaceId: string; actor: string; canManage: boolean; canRead: boolean }) {
  const [grants, setGrants] = useState<import("@/lib/pluto/live").DomainAdminGrant[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [userId, setUserId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!isLive() || !canRead) { setGrants([]); return; }
    setErr(null);
    try {
      const { grants } = await enterprise.domainAdmins();
      setGrants(grants);
    } catch (e) { setErr(e); setGrants([]); }
  }, [canRead]);

  useEffect(() => { void load(); }, [load]);

  async function grant() {
    const id = userId.trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      setErr(new Error("Enter a valid user UUID."));
      return;
    }
    setBusy(true); setErr(null);
    try {
      await enterprise.grantDomainAdmin(id, note.trim() || undefined);
      recordDomainAudit(workspaceId, actor, "domain.admin_grant", id, "ok", { note: note.trim() || null });
      setUserId(""); setNote("");
      await load();
    } catch (e) {
      recordDomainAudit(workspaceId, actor, "domain.admin_grant", id, "error", { message: (e as Error).message });
      setErr(e);
    } finally { setBusy(false); }
  }

  async function revoke(uid: string) {
    if (!confirm(`Revoke domain-admin from ${uid}?`)) return;
    try {
      await enterprise.revokeDomainAdmin(uid);
      recordDomainAudit(workspaceId, actor, "domain.admin_revoke", uid, "ok");
      await load();
    } catch (e) {
      recordDomainAudit(workspaceId, actor, "domain.admin_revoke", uid, "error", { message: (e as Error).message });
      setErr(e);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-1 text-sm font-medium">
        <ShieldCheck className="h-4 w-4" /> Domain-admin permission
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Grant selected users the ability to manage custom domains for this workspace without giving them full
        workspace-admin rights. Only workspace owners/admins can grant or revoke this permission.
      </p>

      <ErrorBanner error={err} onDismiss={() => setErr(null)} />

      {canManage && (
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] mb-3">
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="user UUID"
            className="rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="note (optional)"
            className="rounded-md border border-input bg-background px-3 py-2 text-xs"
          />
          <button
            onClick={() => void grant()}
            disabled={busy || !userId.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Grant
          </button>
        </div>
      )}

      <table className="w-full text-sm">
        <thead className="text-xs uppercase text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2">User</th>
            <th className="text-left px-3 py-2">Note</th>
            <th className="text-left px-3 py-2">Granted by</th>
            <th className="text-left px-3 py-2">Granted at</th>
            <th className="text-right px-3 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {grants === null && (
            <tr><td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</td></tr>
          )}
          {grants && grants.length === 0 && (
            <tr><td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground">
              No domain-admin grants yet. Only workspace owners/admins can manage custom domains.
            </td></tr>
          )}
          {grants?.map((g) => (
            <tr key={g.user_id} className="border-t border-border">
              <td className="px-3 py-2 font-mono text-[11px]">{g.user_id}</td>
              <td className="px-3 py-2 text-xs">{g.note ?? "—"}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{g.granted_by ?? "—"}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(g.granted_at).toLocaleString()}</td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() => void revoke(g.user_id)}
                  disabled={!canManage}
                  title={!canManage ? "Workspace admin role required" : undefined}
                  className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RetryStatus({
  attempt, label, onCancel,
}: { attempt: RetryAttempt | undefined; label: string; onCancel: () => void }) {
  if (!attempt) return null;
  const waiting = attempt.waitingMs > 0;
  return (
    <div className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin text-amber-400" />
      <span>
        {label} · attempt {attempt.attempt}/{attempt.maxAttempts}
        {waiting && <> · retrying in {Math.round(attempt.waitingMs / 1000)}s</>}
      </span>
      <button
        onClick={onCancel}
        className="inline-flex items-center gap-0.5 rounded border border-border px-1 py-0.5 hover:bg-accent"
        title="Cancel retry loop"
      >
        <StopCircle className="h-3 w-3" /> Cancel
      </button>
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
