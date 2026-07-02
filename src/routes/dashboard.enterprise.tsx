import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2, Globe, ShieldCheck, Activity, CheckCircle2, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import {
  isLive, enterprise,
  type IpRule, type CustomDomain, type RegionConfig, type StatusComponent, type StatusIncident,
} from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/enterprise")({ component: EnterprisePage });

// Enterprise & Multi-region console (Phase 20). Manages IP allow/deny
// lists, custom domain claims, region routing hints, and the public
// status page components/incidents.

function EnterprisePage() {
  const [rules, setRules] = useState<IpRule[]>([]);
  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [regions, setRegions] = useState<RegionConfig>({ primary_region: "auto", read_regions: [], pin_writes: true });
  const [status, setStatus] = useState<{ overall: string; components: StatusComponent[]; incidents: StatusIncident[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [rule, setRule] = useState({ cidr: "", action: "allow" as "allow" | "deny", note: "" });
  const [domain, setDomain] = useState("");
  const [ipCheck, setIpCheck] = useState({ ip: "", result: null as string | null });
  const [incident, setIncident] = useState({ title: "", severity: "minor" });

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
  const verify = async (id: string) => {
    try { await enterprise.verifyDomain(id); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const saveRegions = async () => {
    try { setRegions(await enterprise.updateRegions(regions)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const runIpCheck = async () => {
    const ws = localStorage.getItem("pluto.workspace_id") || "00000000-0000-0000-0000-000000000000";
    try { const r = await enterprise.checkIp(ws, ipCheck.ip); setIpCheck({ ...ipCheck, result: `${r.decision} (${r.matched} rule matches)` }); }
    catch (e) { setIpCheck({ ...ipCheck, result: e instanceof Error ? e.message : String(e) }); }
  };
  const publishIncident = async () => {
    if (!incident.title) return;
    try { await enterprise.postIncident({ title: incident.title, severity: incident.severity }); setIncident({ title: "", severity: "minor" }); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const overallColor = status?.overall === "operational" ? "text-emerald-500" :
    status?.overall === "maintenance" ? "text-sky-500" : "text-rose-500";

  return (
    <div className="space-y-6">
      <PageHeader title="Enterprise & Multi-region"
        description="IP access rules, custom domains, region routing, and the public status page (Phase 20)" />
      <div className="flex justify-end">
        <button onClick={() => void load()}
          className="inline-flex items-center gap-2 text-sm rounded-md border border-border px-3 py-1.5 hover:bg-accent">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
        </button>
      </div>
      {err && <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-500">{err}</div>}

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
        <div className="flex gap-2 items-center pt-2 border-t border-border/60">
          <input value={ipCheck.ip} onChange={(e) => setIpCheck({ ...ipCheck, ip: e.target.value })}
            placeholder="Test IP e.g. 203.0.113.5"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm font-mono" />
          <button onClick={() => void runIpCheck()}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">Check</button>
          {ipCheck.result && <span className="text-xs text-muted-foreground">→ {ipCheck.result}</span>}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 font-semibold"><Globe className="h-4 w-4" /> Custom domains</div>
        <div className="flex gap-2">
          <input value={domain} onChange={(e) => setDomain(e.target.value)}
            placeholder="api.acme.com"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          <button onClick={() => void addDomain()}
            className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm">Claim</button>
        </div>
        <ul className="text-sm divide-y divide-border">
          {domains.length === 0 && <li className="py-2 text-muted-foreground">No domains claimed.</li>}
          {domains.map((d) => (
            <li key={d.id} className="py-2 space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-mono">{d.hostname}</span>
                {d.verified
                  ? <span className="text-xs text-emerald-500 inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> verified</span>
                  : <span className="text-xs text-amber-500 inline-flex items-center gap-1"><XCircle className="h-3 w-3" /> pending</span>}
                <span className="text-xs text-muted-foreground flex-1">cert: {d.cert_status}</span>
                {!d.verified && (
                  <button onClick={() => void verify(d.id)}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">Verify</button>
                )}
              </div>
              {!d.verified && (
                <div className="text-xs text-muted-foreground">
                  Add DNS TXT <code>_pluto-verify.{d.hostname}</code> = <code>{d.verify_token}</code>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

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
            {status.incidents.length > 0 && (
              <ul className="text-xs divide-y divide-border pt-2">
                {status.incidents.map((i) => (
                  <li key={i.id} className="py-1.5 flex items-center justify-between gap-2">
                    <span className="font-medium">{i.title}</span>
                    <span className="text-muted-foreground">{i.severity}</span>
                    <span className={i.resolved_at ? "text-emerald-500" : "text-amber-500"}>{i.resolved_at ? "resolved" : "open"}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}
