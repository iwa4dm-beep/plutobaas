import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2, RefreshCw, Trash2, Globe, ShieldCheck, Activity,
  CheckCircle2, XCircle, AlertTriangle, Clock, Radio,
} from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";
import {
  isLive, enterprise,
  type IpRule, type CustomDomain, type RegionConfig, type StatusComponent, type StatusIncident,
} from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/enterprise")({ component: EnterprisePage });

// Phase 20 console — extended with incident timeline filters, automated
// DNS TXT polling for pending custom domains, and a live IP allow/deny
// tester that surfaces matched rules.

const SEVERITIES = ["all", "minor", "major", "critical", "maintenance"] as const;
type Severity = typeof SEVERITIES[number];
const TIME_WINDOWS: Record<string, number | null> = {
  "1h": 60 * 60_000, "24h": 24 * 60 * 60_000, "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000, "all": null,
};

type IpCheckResult = {
  decision: "allow" | "deny";
  matched: number;
  has_allow_list: boolean;
  matched_rules?: IpRule[];
  reason?: string;
} | { error: string } | null;

function EnterprisePage() {
  const [rules, setRules] = useState<IpRule[]>([]);
  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [regions, setRegions] = useState<RegionConfig>({ primary_region: "auto", read_regions: [], pin_writes: true });
  const [status, setStatus] = useState<{ overall: string; components: StatusComponent[]; incidents: StatusIncident[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [rule, setRule] = useState({ cidr: "", action: "allow" as "allow" | "deny", note: "" });
  const [domain, setDomain] = useState("");
  const [ipCheck, setIpCheck] = useState<{ ip: string; result: IpCheckResult; busy: boolean }>({ ip: "", result: null, busy: false });
  const [incident, setIncident] = useState({ title: "", severity: "minor" });

  // Incident timeline filters
  const [sevFilter, setSevFilter] = useState<Severity>("all");
  const [windowKey, setWindowKey] = useState<string>("7d");
  const [openOnly, setOpenOnly] = useState(false);

  // DNS auto-poll state
  const [dnsPoll, setDnsPoll] = useState<Record<string, { lastAt: number; status: "checking" | "ok" | "missing" | "error"; note?: string }>>({});
  const pollingRef = useRef(false);

  const load = useCallback(async () => {
    if (!isLive()) { setErr("Live backend not configured. Set VITE_PLUTO_URL."); return; }
    setLoading(true); setErr(null);
    try {
      const [r, d, reg, s] = await Promise.all([
        enterprise.ipRules(), enterprise.domains(), enterprise.regions(), enterprise.status(),
      ]);
      setRules(r.rules); setDomains(d.domains); setRegions(reg); setStatus(s);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Auto-poll DNS TXT verification for pending domains every 20s.
  useEffect(() => {
    const pending = domains.filter((d) => !d.verified);
    if (pending.length === 0) return;
    let cancelled = false;

    const pollOnce = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        for (const d of pending) {
          if (cancelled) break;
          setDnsPoll((m) => ({ ...m, [d.id]: { lastAt: Date.now(), status: "checking" } }));
          try {
            const r = await enterprise.verifyDomain(d.id);
            setDnsPoll((m) => ({
              ...m,
              [d.id]: {
                lastAt: Date.now(),
                status: r.verified ? "ok" : "missing",
                note: r.verified ? "TXT record matched — domain verified." : "TXT record not found yet.",
              },
            }));
            if (r.verified && !cancelled) await load();
          } catch (e) {
            setDnsPoll((m) => ({
              ...m,
              [d.id]: { lastAt: Date.now(), status: "error", note: e instanceof Error ? e.message : String(e) },
            }));
          }
        }
      } finally { pollingRef.current = false; }
    };

    void pollOnce();
    const t = setInterval(() => { void pollOnce(); }, 20_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [domains, load]);

  const addRule = async () => {
    if (!rule.cidr) return;
    try { await enterprise.addIpRule(rule); setRule({ cidr: "", action: "allow", note: "" }); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const addDomain = async () => {
    if (!domain) return;
    try { await enterprise.addDomain(domain); setDomain(""); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const forceVerify = async (id: string) => {
    try {
      const r = await enterprise.verifyDomain(id);
      setDnsPoll((m) => ({
        ...m,
        [id]: { lastAt: Date.now(), status: r.verified ? "ok" : "missing", note: r.verified ? "Verified." : "TXT record not found." },
      }));
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const saveRegions = async () => {
    try { setRegions(await enterprise.updateRegions(regions)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const runIpCheck = async () => {
    if (!ipCheck.ip) return;
    setIpCheck((s) => ({ ...s, busy: true, result: null }));
    const ws = localStorage.getItem("pluto.workspace_id") || "00000000-0000-0000-0000-000000000000";
    try {
      const r = await enterprise.checkIp(ws, ipCheck.ip);
      setIpCheck((s) => ({ ...s, busy: false, result: r }));
    } catch (e) {
      setIpCheck((s) => ({ ...s, busy: false, result: { error: e instanceof Error ? e.message : String(e) } }));
    }
  };
  const publishIncident = async () => {
    if (!incident.title) return;
    try { await enterprise.postIncident({ title: incident.title, severity: incident.severity }); setIncident({ title: "", severity: "minor" }); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const overallColor = status?.overall === "operational" ? "text-emerald-500" :
    status?.overall === "maintenance" ? "text-sky-500" : "text-rose-500";

  const filteredIncidents = useMemo(() => {
    if (!status) return [];
    const cutoff = TIME_WINDOWS[windowKey];
    const since = cutoff ? Date.now() - cutoff : 0;
    return status.incidents
      .filter((i) => sevFilter === "all" || i.severity === sevFilter)
      .filter((i) => !openOnly || !i.resolved_at)
      .filter((i) => new Date(i.started_at).getTime() >= since)
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
  }, [status, sevFilter, windowKey, openOnly]);

  const sevColor = (s: string) =>
    s === "critical" ? "bg-rose-500/15 text-rose-500" :
    s === "major" ? "bg-orange-500/15 text-orange-500" :
    s === "maintenance" ? "bg-sky-500/15 text-sky-500" :
    "bg-amber-500/15 text-amber-500";

  return (
    <div className="space-y-6">
      <PageHeader title="Enterprise & Multi-region"
        description="IP access rules, custom domains, region routing, and the public status page (Phase 20)" />
      <AutoHelpPanel slug={'dashboard.enterprise'} title={'Enterprise & Multi-region'} description={'IP access rules, custom domains, region routing, and the public status page (Phase 20)'} />
      <div className="flex justify-end">
        <button onClick={() => void load()}
          className="inline-flex items-center gap-2 text-sm rounded-md border border-border px-3 py-1.5 hover:bg-accent">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
        </button>
      </div>
      {err && <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-500">{err}</div>}

      {/* ---------------- IP access rules + live tester ---------------- */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4" /> IP access rules</div>
        <div className="text-xs text-muted-foreground">
          Deny rules always win. When any allow rule exists, unlisted IPs are rejected.
        </div>
        <div className="flex flex-wrap gap-2">
          <input value={rule.cidr} onChange={(e) => setRule({ ...rule, cidr: e.target.value })}
            placeholder="203.0.113.0/24"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm font-mono" />
          <select value={rule.action} onChange={(e) => setRule({ ...rule, action: e.target.value as "allow" | "deny" })}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm">
            <option value="allow">allow</option><option value="deny">deny</option>
          </select>
          <input value={rule.note} onChange={(e) => setRule({ ...rule, note: e.target.value })}
            placeholder="note (optional)"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          <button onClick={() => void addRule()}
            className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm">Add</button>
        </div>
        <ul className="text-sm divide-y divide-border">
          {rules.length === 0 && <li className="py-2 text-muted-foreground">No rules — access is open.</li>}
          {rules.map((r) => (
            <li key={r.id} className="py-2 flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded ${r.action === "allow" ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"}`}>{r.action}</span>
              <span className="font-mono text-sm">{r.cidr}</span>
              <span className="text-xs text-muted-foreground flex-1">{r.note ?? ""}</span>
              <button onClick={async () => { await enterprise.removeIpRule(r.id); await load(); }}
                className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
                <Trash2 className="h-3 w-3 inline" />
              </button>
            </li>
          ))}
        </ul>

        {/* Live IP tester */}
        <div className="mt-2 rounded-md border border-border/60 bg-muted/30 p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Radio className="h-3.5 w-3.5" /> Live rule tester
            <span className="text-xs text-muted-foreground font-normal">— calls <code>/ip-rules/check</code></span>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <input value={ipCheck.ip}
              onChange={(e) => setIpCheck({ ...ipCheck, ip: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") void runIpCheck(); }}
              placeholder="e.g. 203.0.113.5 or 2001:db8::1"
              className="flex-1 min-w-[200px] rounded-md border border-border bg-background px-2 py-1 text-sm font-mono" />
            <button onClick={() => void runIpCheck()} disabled={ipCheck.busy || !ipCheck.ip}
              className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm disabled:opacity-50 inline-flex items-center gap-1.5">
              {ipCheck.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Radio className="h-3 w-3" />}
              Check
            </button>
          </div>
          {ipCheck.result && "error" in ipCheck.result && (
            <div className="text-xs text-rose-500">Error: {ipCheck.result.error}</div>
          )}
          {ipCheck.result && "decision" in ipCheck.result && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                {ipCheck.result.decision === "allow"
                  ? <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 text-emerald-500 px-2 py-1 text-xs font-medium"><CheckCircle2 className="h-3 w-3" /> ALLOW</span>
                  : <span className="inline-flex items-center gap-1 rounded-md bg-rose-500/15 text-rose-500 px-2 py-1 text-xs font-medium"><XCircle className="h-3 w-3" /> DENY</span>}
                <span className="text-xs text-muted-foreground">
                  {ipCheck.result.matched} matching rule{ipCheck.result.matched === 1 ? "" : "s"}
                  {ipCheck.result.has_allow_list ? " · allow-list active" : " · open by default"}
                </span>
              </div>
              {ipCheck.result.reason && (
                <div className="text-xs text-muted-foreground italic">{ipCheck.result.reason}</div>
              )}
              {ipCheck.result.matched_rules && ipCheck.result.matched_rules.length > 0 && (
                <ul className="text-xs space-y-1">
                  {ipCheck.result.matched_rules.map((mr) => (
                    <li key={mr.id} className="flex items-center gap-2">
                      <span className={`px-1.5 py-0.5 rounded ${mr.action === "allow" ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"}`}>{mr.action}</span>
                      <span className="font-mono">{mr.cidr}</span>
                      {mr.note && <span className="text-muted-foreground">— {mr.note}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ---------------- Custom domains + DNS auto-poll ---------------- */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 font-semibold">
          <Globe className="h-4 w-4" /> Custom domains
          <span className="text-xs text-muted-foreground font-normal">— pending domains are auto-checked every 20s</span>
        </div>
        <div className="flex gap-2">
          <input value={domain} onChange={(e) => setDomain(e.target.value)}
            placeholder="api.acme.com"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          <button onClick={() => void addDomain()}
            className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm">Claim</button>
        </div>
        <ul className="text-sm divide-y divide-border">
          {domains.length === 0 && <li className="py-2 text-muted-foreground">No domains claimed.</li>}
          {domains.map((d) => {
            const p = dnsPoll[d.id];
            return (
              <li key={d.id} className="py-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono">{d.hostname}</span>
                  {d.verified
                    ? <span className="text-xs text-emerald-500 inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> verified</span>
                    : <span className="text-xs text-amber-500 inline-flex items-center gap-1"><XCircle className="h-3 w-3" /> pending</span>}
                  <span className="text-xs text-muted-foreground">cert: {d.cert_status}</span>
                  {!d.verified && p && (
                    <span className={`text-xs inline-flex items-center gap-1 ${
                      p.status === "ok" ? "text-emerald-500" :
                      p.status === "checking" ? "text-sky-500" :
                      p.status === "missing" ? "text-amber-500" : "text-rose-500"}`}>
                      {p.status === "checking" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Clock className="h-3 w-3" />}
                      DNS: {p.status} · {new Date(p.lastAt).toLocaleTimeString()}
                    </span>
                  )}
                  <span className="flex-1" />
                  {!d.verified && (
                    <button onClick={() => void forceVerify(d.id)}
                      className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">Check now</button>
                  )}
                </div>
                {!d.verified && (
                  <div className="text-xs text-muted-foreground">
                    Add DNS TXT <code>_pluto-verify.{d.hostname}</code> = <code>{d.verify_token}</code>
                    {p?.note && <span className="ml-1 italic">— {p.note}</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* ---------------- Region routing ---------------- */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Region routing</div>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-xs"><div className="text-muted-foreground">Primary region</div>
            <input value={regions.primary_region}
              onChange={(e) => setRegions({ ...regions, primary_region: e.target.value })}
              className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 text-sm" />
          </label>
          <label className="text-xs"><div className="text-muted-foreground">Read regions (comma)</div>
            <input value={regions.read_regions.join(",")}
              onChange={(e) => setRegions({ ...regions, read_regions: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
              className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 text-sm" />
          </label>
          <label className="text-xs flex items-end gap-2">
            <input type="checkbox" checked={regions.pin_writes}
              onChange={(e) => setRegions({ ...regions, pin_writes: e.target.checked })} />
            <span>Pin writes to primary</span>
          </label>
        </div>
        <button onClick={() => void saveRegions()}
          className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm">Save routing</button>
      </section>

      {/* ---------------- Status page + incident timeline ---------------- */}
      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 font-semibold"><Activity className="h-4 w-4" /> Status page</div>
        {status && (
          <>
            <div className={`text-sm ${overallColor}`}>Overall: {status.overall}</div>
            <ul className="grid gap-1 sm:grid-cols-2 text-sm">
              {status.components.map((c) => (
                <li key={c.id} className="flex items-center justify-between border border-border rounded-md px-3 py-1.5">
                  <span className="capitalize">{c.name}</span>
                  <span className={`text-xs ${c.status === "operational" ? "text-emerald-500" : "text-rose-500"}`}>{c.status}</span>
                </li>
              ))}
            </ul>

            <div className="pt-2 border-t border-border/60">
              <div className="text-xs text-muted-foreground mb-1">Publish incident (admin)</div>
              <div className="flex gap-2">
                <input value={incident.title} onChange={(e) => setIncident({ ...incident, title: e.target.value })}
                  placeholder="Elevated latency in eu-west-1"
                  className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" />
                <select value={incident.severity} onChange={(e) => setIncident({ ...incident, severity: e.target.value })}
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm">
                  <option value="minor">minor</option><option value="major">major</option>
                  <option value="critical">critical</option><option value="maintenance">maintenance</option>
                </select>
                <button onClick={() => void publishIncident()}
                  className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm">Publish</button>
              </div>
            </div>

            {/* Incident timeline with severity + time-range filters */}
            <div className="pt-3 border-t border-border/60 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="h-3.5 w-3.5" /> Incident timeline
                <span className="text-xs text-muted-foreground font-normal">
                  {filteredIncidents.length} of {status.incidents.length}
                </span>
              </div>
              <div className="flex flex-wrap gap-2 items-center text-xs">
                <label className="inline-flex items-center gap-1">Severity
                  <select value={sevFilter} onChange={(e) => setSevFilter(e.target.value as Severity)}
                    className="rounded-md border border-border bg-background px-2 py-1">
                    {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <label className="inline-flex items-center gap-1">Window
                  <select value={windowKey} onChange={(e) => setWindowKey(e.target.value)}
                    className="rounded-md border border-border bg-background px-2 py-1">
                    {Object.keys(TIME_WINDOWS).map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </label>
                <label className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
                  Open only
                </label>
              </div>

              {filteredIncidents.length === 0 ? (
                <div className="text-xs text-muted-foreground italic py-2">No incidents match the current filters.</div>
              ) : (
                <ol className="relative border-l border-border/60 pl-4 space-y-3">
                  {filteredIncidents.map((i) => {
                    const started = new Date(i.started_at);
                    const resolved = i.resolved_at ? new Date(i.resolved_at) : null;
                    const durationMs = (resolved ?? new Date()).getTime() - started.getTime();
                    const mins = Math.max(1, Math.round(durationMs / 60000));
                    const durLabel = mins < 60 ? `${mins}m` : mins < 60 * 24 ? `${(mins / 60).toFixed(1)}h` : `${(mins / 60 / 24).toFixed(1)}d`;
                    return (
                      <li key={i.id} className="relative">
                        <span className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ${resolved ? "bg-emerald-500" : "bg-amber-500 animate-pulse"}`} />
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${sevColor(i.severity)}`}>{i.severity}</span>
                          <span className="text-sm font-medium">{i.title}</span>
                          <span className={`text-xs ${resolved ? "text-emerald-500" : "text-amber-500"}`}>{resolved ? "resolved" : "open"}</span>
                          <span className="text-xs text-muted-foreground ml-auto">{durLabel}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          started {started.toLocaleString()}
                          {resolved && <> · resolved {resolved.toLocaleString()}</>}
                        </div>
                        {i.body && <div className="text-xs mt-0.5">{i.body}</div>}
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
