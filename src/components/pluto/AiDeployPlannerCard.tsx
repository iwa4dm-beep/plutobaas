import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle, CheckCircle2, Copy, Download, History, KeyRound,
  Loader2, Rocket, Server, Shield, Sparkles, Trash2, Upload, Wifi, XCircle,
} from "lucide-react";
import {
  planDeploy, generateVpsGuide, generateUninstallScript,
  runPreflight, checkPostInstallHealth, checkRequiredSecrets,
  checkPortsReachable, runFullVerification,
  type DeployPlan, type VpsGuide, type PreflightCheck, type HealthProbe, type PortProbe,
} from "@/lib/pluto/ai-deploy-planner.functions";
import {
  listPlanHistory, savePlan, attachGuide, deletePlan,
  type PlanHistoryEntry,
} from "@/lib/pluto/deploy-plan-history";
import { listPresets, savePreset, deletePreset, type EnvPreset } from "@/lib/pluto/env-presets";

const WORKSPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/;

type Props = {
  workspaceId: string;
  bundleFile: File | null;
  bundleSql: string;
};

type BusyKind = "preflight" | "plan" | "guide" | "uninstall" | "posthealth" | "secrets" | "ports" | "verify";

type StepStatus = "pending" | "running" | "ok" | "fail";
type Tracker = { id: string; label: string; status: StepStatus; detail?: string };

const INITIAL_TRACKER: Tracker[] = [
  { id: "preflight", label: "Preflight checks", status: "pending" },
  { id: "plan", label: "AI deploy plan", status: "pending" },
  { id: "confirm", label: "User confirms plan", status: "pending" },
  { id: "guide", label: "VPS install & DNS guide", status: "pending" },
  { id: "posthealth", label: "Post-install health", status: "pending" },
];

function download(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CopyBtn({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" variant="outline" onClick={async () => {
      await navigator.clipboard.writeText(text);
      setDone(true); setTimeout(() => setDone(false), 1500);
    }}>
      {done ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
      {done ? "Copied" : label}
    </Button>
  );
}

function StatusBadge({ status }: { status: StepStatus }) {
  const map: Record<StepStatus, { v: "outline" | "secondary" | "destructive"; text: string }> = {
    pending: { v: "outline", text: "pending" },
    running: { v: "outline", text: "running…" },
    ok: { v: "secondary", text: "ok" },
    fail: { v: "destructive", text: "fail" },
  };
  const m = map[status];
  return <Badge variant={m.v}>{m.text}</Badge>;
}

function LineNumberedPre({ text, maxHeight = "max-h-96" }: { text: string; maxHeight?: string }) {
  const lines = text.split("\n");
  return (
    <div className={`overflow-auto bg-muted rounded ${maxHeight} text-xs font-mono`}>
      <table className="w-full">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className="align-top">
              <td className="select-none text-muted-foreground pr-3 pl-2 text-right border-r border-border w-10">{i + 1}</td>
              <td className="pl-3 pr-2 whitespace-pre">{l || "\u00A0"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AiDeployPlannerCard({ workspaceId, bundleFile, bundleSql }: Props) {
  const workspaceIdValid = WORKSPACE_ID_RE.test(workspaceId.trim());

  const [domain, setDomain] = useState("");
  const [vpsIp, setVpsIp] = useState("");
  const [keepCerts, setKeepCerts] = useState(false);

  const [plan, setPlan] = useState<DeployPlan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [editingPreSql, setEditingPreSql] = useState("");
  const [guide, setGuide] = useState<VpsGuide | null>(null);
  const [uninstall, setUninstall] = useState<string | null>(null);

  const [preflight, setPreflight] = useState<{ ok: boolean; checks: PreflightCheck[] } | null>(null);
  const [postHealth, setPostHealth] = useState<{ ok: boolean; probes: HealthProbe[] } | null>(null);
  const [secretsState, setSecretsState] = useState<{ name: string; set: boolean; required: boolean; description: string }[] | null>(null);

  const [busy, setBusy] = useState<BusyKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tracker, setTracker] = useState<Tracker[]>(INITIAL_TRACKER);
  const [logs, setLogs] = useState<{ ts: string; msg: string; level: "info" | "ok" | "warn" | "err" }[]>([]);

  const [history, setHistory] = useState<PlanHistoryEntry[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);

  const [ports, setPorts] = useState<{ ok: boolean; probes: PortProbe[]; tips: string[] } | null>(null);
  const [verification, setVerification] = useState<{ ok: boolean; host: string; probes: HealthProbe[]; checkedAt: string } | null>(null);
  const [presets, setPresets] = useState<EnvPreset[]>([]);
  const [presetName, setPresetName] = useState("");

  const preflightFn = useServerFn(runPreflight);
  const planFn = useServerFn(planDeploy);
  const guideFn = useServerFn(generateVpsGuide);
  const uninstallFn = useServerFn(generateUninstallScript);
  const postHealthFn = useServerFn(checkPostInstallHealth);
  const secretsFn = useServerFn(checkRequiredSecrets);
  const portsFn = useServerFn(checkPortsReachable);
  const verifyFn = useServerFn(runFullVerification);

  useEffect(() => { setHistory(listPlanHistory()); setPresets(listPresets()); }, []);

  const addLog = useCallback((msg: string, level: "info" | "ok" | "warn" | "err" = "info") => {
    setLogs((prev) => [{ ts: new Date().toLocaleTimeString(), msg, level }, ...prev].slice(0, 100));
  }, []);

  const setStep = useCallback((id: string, status: StepStatus, detail?: string) => {
    setTracker((prev) => prev.map((s) => s.id === id ? { ...s, status, detail } : s));
  }, []);

  const resetTracker = () => setTracker(INITIAL_TRACKER.map((s) => ({ ...s, status: "pending", detail: undefined })));

  // ── Preflight ───────────────────────────────────────────────
  const doPreflight = useCallback(async () => {
    setBusy("preflight"); setError(null); resetTracker();
    setStep("preflight", "running");
    addLog("Running preflight checks…");
    try {
      const r = await preflightFn({ data: {
        workspaceId: workspaceId.trim(),
        domain: domain.trim() || undefined,
        bundleName: bundleFile?.name,
      } });
      setPreflight(r);
      setStep("preflight", r.ok ? "ok" : "fail", `${r.checks.filter((c) => c.ok).length}/${r.checks.length} passed`);
      addLog(`Preflight ${r.ok ? "passed" : "has warnings"} — ${r.checks.length} checks`, r.ok ? "ok" : "warn");
    } catch (e) {
      setStep("preflight", "fail", (e as Error).message);
      setError((e as Error).message);
      addLog("Preflight error: " + (e as Error).message, "err");
    } finally { setBusy(null); }
  }, [preflightFn, workspaceId, domain, bundleFile, addLog, setStep]);

  // ── Plan ────────────────────────────────────────────────────
  const doPlan = useCallback(async () => {
    if (!preflight?.ok) { setError("Run & pass preflight first."); return; }
    setBusy("plan"); setError(null);
    setStep("plan", "running");
    addLog("Requesting AI deploy plan…");
    try {
      const p = await planFn({ data: {
        workspaceId: workspaceId.trim(),
        bundleName: bundleFile?.name,
        bundleSizeKb: bundleFile ? Math.round(bundleFile.size / 1024) : undefined,
        hasMigrations: !!bundleSql.trim() && bundleSql.trim() !== "select 1;",
        domain: domain.trim() || undefined,
      } });
      setPlan(p); setConfirmed(false); setEditingPreSql(p.preSql);
      setGuide(null);
      setStep("plan", "ok", `${p.steps.length} steps · model ${p.model}`);
      addLog(`Plan received (${p.steps.length} steps, model=${p.model})`, "ok");
      // Save to history immediately
      const saved = savePlan({ workspaceId: workspaceId.trim(), domain: domain.trim() || undefined, plan: p });
      setActivePlanId(saved.id);
      setHistory(listPlanHistory());
    } catch (e) {
      setStep("plan", "fail", (e as Error).message);
      setError((e as Error).message);
      addLog("Plan error: " + (e as Error).message, "err");
    } finally { setBusy(null); }
  }, [preflight, planFn, workspaceId, bundleFile, bundleSql, domain, addLog, setStep]);

  const confirmPlan = () => {
    if (!plan) return;
    setPlan({ ...plan, preSql: editingPreSql });
    setConfirmed(true);
    setStep("confirm", "ok", "user confirmed");
    addLog("Plan confirmed by user", "ok");
  };

  // ── VPS Guide ───────────────────────────────────────────────
  const doGuide = useCallback(async () => {
    if (!confirmed) { setError("Confirm the plan first."); return; }
    if (!domain.trim()) { setError("Domain required."); return; }
    setBusy("guide"); setError(null);
    setStep("guide", "running");
    addLog(`Generating VPS install script for app.${domain.trim()}…`);
    try {
      const g = await guideFn({ data: {
        domain: domain.trim(),
        vpsIp: vpsIp.trim() || undefined,
        workspaceId: workspaceId.trim(),
      } });
      const u = await uninstallFn({ data: { domain: domain.trim(), keepCerts } });
      setGuide(g); setUninstall(u.script);
      setStep("guide", "ok", `${g.checklist.length} steps · rollback script ready`);
      addLog("VPS guide + rollback script generated", "ok");
      if (activePlanId) { attachGuide(activePlanId, g); setHistory(listPlanHistory()); }
    } catch (e) {
      setStep("guide", "fail", (e as Error).message);
      setError((e as Error).message);
      addLog("Guide error: " + (e as Error).message, "err");
    } finally { setBusy(null); }
  }, [confirmed, domain, vpsIp, workspaceId, keepCerts, guideFn, uninstallFn, activePlanId, addLog, setStep]);

  // ── Post-install Health ─────────────────────────────────────
  const doPostHealth = useCallback(async () => {
    if (!domain.trim()) { setError("Domain required."); return; }
    setBusy("posthealth"); setError(null);
    setStep("posthealth", "running");
    addLog(`Probing https://app.${domain.trim()}/ …`);
    try {
      const r = await postHealthFn({ data: { domain: domain.trim() } });
      setPostHealth(r);
      setStep("posthealth", r.ok ? "ok" : "fail", `${r.probes.filter((p) => p.ok).length}/${r.probes.length} probes ok`);
      addLog(`Post-install health ${r.ok ? "PASS" : "FAIL"} — ${r.probes.length} probes`, r.ok ? "ok" : "err");
    } catch (e) {
      setStep("posthealth", "fail", (e as Error).message);
      setError((e as Error).message);
    } finally { setBusy(null); }
  }, [domain, postHealthFn, addLog, setStep]);

  // ── Secrets wizard ──────────────────────────────────────────
  const refreshSecrets = useCallback(async () => {
    setBusy("secrets");
    try { setSecretsState((await secretsFn()).secrets); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }, [secretsFn]);

  useEffect(() => { refreshSecrets(); }, [refreshSecrets]);

  const missingRequired = useMemo(
    () => (secretsState ?? []).filter((s) => s.required && !s.set).map((s) => s.name),
    [secretsState],
  );

  const restoreFromHistory = (entry: PlanHistoryEntry) => {
    setPlan(entry.plan); setEditingPreSql(entry.plan.preSql);
    setGuide(entry.guide ?? null); setConfirmed(!!entry.guide);
    setDomain(entry.domain ?? ""); setActivePlanId(entry.id);
    addLog(`Restored plan from ${new Date(entry.createdAt).toLocaleString()}`, "info");
  };

  const removeFromHistory = (id: string) => {
    deletePlan(id); setHistory(listPlanHistory());
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> AI Deploy Planner
          <span className="ml-2 text-xs text-muted-foreground font-normal">preflight → plan → confirm → guide → verify</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">

        {/* Inputs */}
        <div className="grid gap-3 md:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ai-domain">Domain</Label>
            <Input id="ai-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="timescar.cloud" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ai-vps">VPS public IP</Label>
            <Input id="ai-vps" value={vpsIp} onChange={(e) => setVpsIp(e.target.value)} placeholder="203.0.113.10" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ai-keep-certs" className="flex items-center gap-2">
              <input id="ai-keep-certs" type="checkbox" checked={keepCerts} onChange={(e) => setKeepCerts(e.target.checked)} />
              <span>Rollback keeps TLS certs</span>
            </Label>
            <span className="text-xs text-muted-foreground">Uncheck to revoke Let's Encrypt on uninstall.</span>
          </div>
        </div>

        {/* Secrets wizard */}
        <div className="border rounded-md p-3 space-y-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            <span className="font-medium text-sm">Secrets setup wizard</span>
            <Button size="sm" variant="ghost" onClick={refreshSecrets} disabled={busy === "secrets"} className="ml-auto">
              {busy === "secrets" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Recheck"}
            </Button>
          </div>
          {missingRequired.length > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Missing required secrets: <code>{missingRequired.join(", ")}</code>.
                Open <b>Project Settings → Secrets</b> and add them.
                Values needed: <code>PLUTO_SANDBOX_URL=https://app.{domain || "yourdomain.com"}</code> and
                <code> PLUTO_SANDBOX_SECRET</code> from <code>/etc/pluto-sandbox/env</code> on the VPS.
              </AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1 text-xs">
            {(secretsState ?? []).map((s) => (
              <div key={s.name} className="flex items-start gap-2">
                {s.set ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mt-0.5" /> : <XCircle className={`h-3.5 w-3.5 mt-0.5 ${s.required ? "text-destructive" : "text-muted-foreground"}`} />}
                <div>
                  <code className="font-medium">{s.name}</code>
                  {!s.required && <span className="ml-1 text-muted-foreground">(optional)</span>}
                  <div className="text-muted-foreground">{s.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Status tracker */}
        <div className="border rounded-md p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4" />
            <span className="font-medium text-sm">Deploy status tracker</span>
          </div>
          <ol className="grid gap-1.5 text-xs">
            {tracker.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2">
                <Badge variant="outline" className="w-6 justify-center">{i + 1}</Badge>
                <span className="flex-1">{s.label}</span>
                {s.detail && <span className="text-muted-foreground text-[10px]">{s.detail}</span>}
                <StatusBadge status={s.status} />
              </li>
            ))}
          </ol>
        </div>

        {/* Actions */}
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" onClick={doPreflight} disabled={busy !== null || !workspaceIdValid}>
            {busy === "preflight" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Shield className="h-4 w-4 mr-2" />}
            1. Preflight
          </Button>
          <Button size="sm" onClick={doPlan} disabled={busy !== null || !preflight?.ok}>
            {busy === "plan" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
            2. Generate plan
          </Button>
          <Button size="sm" onClick={doGuide} disabled={busy !== null || !confirmed || !domain.trim()}>
            {busy === "guide" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Server className="h-4 w-4 mr-2" />}
            4. VPS guide
          </Button>
          <Button size="sm" variant="outline" onClick={doPostHealth} disabled={busy !== null || !domain.trim()}>
            {busy === "posthealth" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
            5. Post-install health
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Preflight results */}
        {preflight && (
          <div className="border rounded-md p-3 text-xs space-y-1">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant={preflight.ok ? "secondary" : "destructive"}>{preflight.ok ? "preflight ok" : "preflight failed"}</Badge>
            </div>
            {preflight.checks.map((c, i) => (
              <div key={i} className="flex items-start gap-2">
                {c.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mt-0.5" /> : <XCircle className="h-3.5 w-3.5 text-destructive mt-0.5" />}
                <div><b>{c.name}</b> — <span className="text-muted-foreground">{c.detail}</span></div>
              </div>
            ))}
          </div>
        )}

        {/* Plan verification & confirm */}
        {plan && (
          <div className="border rounded-md p-3 text-xs space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary">plan · model {plan.model}</Badge>
              <span className="text-muted-foreground">{plan.summary}</span>
              <div className="ml-auto flex gap-2">
                <CopyBtn text={JSON.stringify(plan, null, 2)} label="Copy JSON" />
                <Button size="sm" variant="outline" onClick={() => download(`plan-${workspaceId.trim()}-${Date.now()}.json`, JSON.stringify(plan, null, 2), "application/json")}>
                  <Download className="h-3 w-3 mr-1" /> Export JSON
                </Button>
              </div>
            </div>

            <div>
              <div className="font-medium mb-1">Steps</div>
              <ol className="space-y-1.5">
                {plan.steps.map((s, i) => (
                  <li key={s.id} className="flex gap-2">
                    <Badge variant="outline">{i + 1}</Badge>
                    <div>
                      <div><b>{s.title}</b> <span className="text-muted-foreground">· {s.kind} · risk {s.risk}</span></div>
                      <div className="text-muted-foreground">{s.detail}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div>
              <div className="font-medium mb-1">Pre-deploy SQL (editable)</div>
              <Textarea rows={4} className="font-mono text-xs" value={editingPreSql} onChange={(e) => setEditingPreSql(e.target.value)} disabled={confirmed} />
            </div>

            {plan.risks.length > 0 && (
              <div>
                <div className="font-medium mb-1">Risks</div>
                <ul className="space-y-1">
                  {plan.risks.map((r, i) => (
                    <li key={i} className="flex gap-2">
                      <Badge variant={r.severity === "high" ? "destructive" : "secondary"}>{r.severity}</Badge>
                      <span>{r.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {plan.postChecks.length > 0 && (
              <div>
                <div className="font-medium mb-1">Post-deploy checks</div>
                <ul className="list-disc pl-5 space-y-0.5">
                  {plan.postChecks.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            )}

            <Separator />
            <div className="flex items-center gap-2">
              {confirmed ? (
                <>
                  <Badge variant="secondary"><CheckCircle2 className="h-3 w-3 mr-1" /> Confirmed</Badge>
                  <Button size="sm" variant="ghost" onClick={() => { setConfirmed(false); setStep("confirm", "pending"); }}>Edit again</Button>
                </>
              ) : (
                <Button size="sm" onClick={confirmPlan}>3. Confirm plan &amp; proceed</Button>
              )}
            </div>
          </div>
        )}

        {/* VPS guide */}
        {guide && (
          <div className="border rounded-md p-3 text-xs space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="secondary">VPS install guide</Badge>
              <span className="text-muted-foreground">{guide.checklist.length} steps · {guide.dnsRecords.length} DNS record(s)</span>
            </div>

            <div>
              <div className="font-medium mb-1">DNS records</div>
              <ul className="space-y-1">
                {guide.dnsRecords.map((d, i) => (
                  <li key={i} className="flex flex-wrap gap-2 items-center">
                    <Badge variant="outline">{d.type}</Badge>
                    <code>{d.name}</code><span className="text-muted-foreground">→</span>
                    <code className="break-all">{d.value}</code>
                    <span className="text-muted-foreground">— {d.note}</span>
                    <CopyBtn text={`${d.type}\t${d.name}\t${d.value}`} label="Copy row" />
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <div className="font-medium mb-1">Checklist</div>
              <ol className="space-y-1.5">
                {guide.checklist.map((c) => (
                  <li key={c.step} className="border-l-2 pl-2 border-muted">
                    <div><b>{c.step}. {c.title}</b></div>
                    {c.command && <pre className="mt-1 bg-muted p-2 rounded overflow-auto whitespace-pre">{c.command}</pre>}
                    {c.note && <div className="text-muted-foreground">{c.note}</div>}
                  </li>
                ))}
              </ol>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="font-medium">Install script (Bash, line-numbered)</div>
                <div className="flex gap-2">
                  <CopyBtn text={guide.script} label="Copy script" />
                  <Button size="sm" variant="outline" onClick={() => download(`pluto-install-${domain.trim() || "app"}.sh`, guide.script, "text/x-shellscript")}>
                    <Download className="h-3 w-3 mr-1" /> Download .sh
                  </Button>
                </div>
              </div>
              <LineNumberedPre text={guide.script} />
            </div>

            {uninstall && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="font-medium">Rollback / uninstall script</div>
                  <div className="flex gap-2">
                    <CopyBtn text={uninstall} label="Copy rollback" />
                    <Button size="sm" variant="outline" onClick={() => download(`pluto-uninstall-${domain.trim() || "app"}.sh`, uninstall, "text/x-shellscript")}>
                      <Download className="h-3 w-3 mr-1" /> Download rollback
                    </Button>
                  </div>
                </div>
                <LineNumberedPre text={uninstall} maxHeight="max-h-64" />
              </div>
            )}
          </div>
        )}

        {/* Post-install health results */}
        {postHealth && (
          <div className="border rounded-md p-3 text-xs space-y-2">
            <div className="flex items-center gap-2">
              <Badge variant={postHealth.ok ? "secondary" : "destructive"}>
                {postHealth.ok ? "post-install ok" : "post-install failing"}
              </Badge>
              <span className="text-muted-foreground">nginx / TLS / backend probes</span>
            </div>
            <ul className="grid gap-1">
              {postHealth.probes.map((p, i) => (
                <li key={i} className="flex items-start gap-2">
                  {p.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mt-0.5" /> : <XCircle className="h-3.5 w-3.5 text-destructive mt-0.5" />}
                  <div><b>{p.name}</b> — <span className="text-muted-foreground">{p.detail}</span></div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Streaming logs */}
        {logs.length > 0 && (
          <div className="border rounded-md p-3 text-xs">
            <div className="font-medium mb-2">Activity log</div>
            <ul className="space-y-0.5 max-h-56 overflow-auto font-mono">
              {logs.map((l, i) => (
                <li key={i} className={
                  l.level === "err" ? "text-destructive"
                  : l.level === "warn" ? "text-yellow-700 dark:text-yellow-500"
                  : l.level === "ok" ? "text-green-700 dark:text-green-500"
                  : "text-muted-foreground"
                }>
                  [{l.ts}] {l.msg}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Plan history */}
        <div className="border rounded-md p-3 space-y-2">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4" />
            <span className="font-medium text-sm">Plan history</span>
            <span className="text-xs text-muted-foreground">({history.length} saved)</span>
          </div>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No saved plans yet. Generate a plan above — it'll be saved automatically.</p>
          ) : (
            <ul className="space-y-1 max-h-64 overflow-auto">
              {history.map((h) => (
                <li key={h.id} className="flex items-center gap-2 text-xs border rounded p-2">
                  <div className="flex-1">
                    <div>
                      <code className="text-[10px]">{h.id}</code>
                      <span className="ml-2 text-muted-foreground">{new Date(h.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="text-muted-foreground">
                      workspace <code>{h.workspaceId}</code>
                      {h.domain && <> · domain <code>{h.domain}</code></>}
                      · {h.plan.steps.length} steps
                      {h.guide && <> · guide ✓</>}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => restoreFromHistory(h)}>Restore</Button>
                  <Button size="sm" variant="outline" onClick={() => download(`plan-${h.id}.json`, JSON.stringify(h, null, 2), "application/json")}>
                    <Download className="h-3 w-3" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => removeFromHistory(h.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
