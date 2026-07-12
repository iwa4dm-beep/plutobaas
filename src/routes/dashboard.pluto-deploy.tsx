import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Activity, Play, RefreshCw, Rocket, ShieldAlert, Wrench } from "lucide-react";
import { plutoApi } from "@/lib/pluto/upstream";
import { useServerFn } from "@tanstack/react-start";
import { deployAll, ensureDeployInfra, postDeployHealth, type DeployAllResult, type EnsureInfraResult, type PostDeployHealth } from "@/lib/pluto/vps-deployer.functions";

const WORKSPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/;

export const Route = createFileRoute("/dashboard/pluto-deploy")({
  component: DeployPage,
});

type HealthMigrations = {
  status: "ok" | "degraded";
  migrations?: { ok: boolean; count?: number; current?: string | null; applied?: string[]; error?: string };
  auth_shim?: { ok: boolean; probes: Record<string, { ok: boolean; error?: string; code?: string }> };
};

type LogEntry = {
  ts: string;
  request: unknown;
  status: number;
  response: unknown;
  duration_ms: number;
};

function DeployPage() {
  const [health, setHealth] = useState<HealthMigrations | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(false);

  const [sql, setSql] = useState("select current_database(), current_user, now();");
  const [readOnly, setReadOnly] = useState(true);
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const [allowDangerous, setAllowDangerous] = useState(false);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Real-deploy state
  const [workspaceId, setWorkspaceId] = useState("");
  const [bundleFile, setBundleFile] = useState<File | null>(null);
  const [bundleSql, setBundleSql] = useState("-- optional migration SQL to run before the bundle upload\nselect 1;");
  const [maxRetries, setMaxRetries] = useState(2);
  const [deployBusy, setDeployBusy] = useState<null | "infra" | "deploy" | "health">(null);
  const [infraResult, setInfraResult] = useState<EnsureInfraResult | null>(null);
  const [deployResult, setDeployResult] = useState<DeployAllResult | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [postHealth, setPostHealth] = useState<PostDeployHealth | null>(null);

  const workspaceIdValid = WORKSPACE_ID_RE.test(workspaceId.trim());

  const ensureInfraFn = useServerFn(ensureDeployInfra);
  const deployAllFn = useServerFn(deployAll);
  const postDeployHealthFn = useServerFn(postDeployHealth);

  const refreshPostHealth = useCallback(async () => {
    if (!workspaceIdValid) { setDeployError("Enter a valid workspace ID first"); return; }
    setDeployBusy("health");
    try {
      const h = await postDeployHealthFn({ data: { workspaceId: workspaceId.trim() } });
      setPostHealth(h);
    } catch (e) {
      setDeployError((e as Error).message);
    } finally {
      setDeployBusy(null);
    }
  }, [workspaceId, workspaceIdValid, postDeployHealthFn]);

  const runEnsureInfra = useCallback(async () => {
    setDeployBusy("infra");
    setDeployError(null);
    try {
      const r = await ensureInfraFn({ data: { bucket: "deployments" } });
      setInfraResult(r);
    } catch (e) {
      setDeployError((e as Error).message);
    } finally {
      setDeployBusy(null);
    }
  }, [ensureInfraFn]);

  const runFullDeploy = useCallback(async () => {
    if (!workspaceIdValid) { setDeployError("Invalid workspace ID"); return; }
    if (!bundleFile) { setDeployError("Select a bundle .zip first"); return; }
    setDeployBusy("deploy");
    setDeployError(null);
    setDeployResult(null);
    try {
      const buf = new Uint8Array(await bundleFile.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
      const contentBase64 = btoa(binary);
      const bundlePath = `${workspaceId.trim()}/${bundleFile.name}`;
      const r = await deployAllFn({ data: {
        workspaceId: workspaceId.trim(),
        sql: bundleSql.trim() || "select 1;",
        bundlePath,
        contentBase64,
        bucket: "deployments",
        maxRetries,
        ensureInfra: true,
        label: `deploy-${bundleFile.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}`,
      } });
      setDeployResult(r);
    } catch (e) {
      setDeployError((e as Error).message);
    } finally {
      setDeployBusy(null);
    }
  }, [workspaceId, workspaceIdValid, bundleFile, bundleSql, maxRetries, deployAllFn]);

  const refreshHealth = useCallback(async () => {
    setLoadingHealth(true);
    setHealthErr(null);
    try {
      const h = await plutoApi<HealthMigrations>("/health/migrations");
      setHealth(h);
    } catch (e: any) {
      setHealthErr(e?.message ?? String(e));
    } finally {
      setLoadingHealth(false);
    }
  }, []);

  useEffect(() => { refreshHealth(); }, [refreshHealth]);

  const runSql = useCallback(async () => {
    setRunning(true);
    const body = { sql, read_only: readOnly, confirm_destructive: confirmDestructive, allow_dangerous: allowDangerous };
    const started = Date.now();
    let status = 0;
    let response: unknown = null;
    try {
      const res = await plutoApi<any>("/admin/v1/sql/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // @ts-expect-error — plutoApi returns parsed body; capture status via wrapper below.
        __captureStatus: (s: number) => { status = s; },
      });
      response = res;
      status = status || 200;
    } catch (e: any) {
      response = { error: e?.message ?? String(e) };
      status = status || 0;
    }
    setLogs((prev) => [{ ts: new Date().toISOString(), request: body, status, response, duration_ms: Date.now() - started }, ...prev].slice(0, 25));
    setRunning(false);
  }, [sql, readOnly, confirmDestructive, allowDangerous]);

  const applied = health?.migrations?.applied ?? [];
  const authProbes = useMemo(() => Object.entries(health?.auth_shim?.probes ?? {}), [health]);

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Deploy & Migrations"
        description="Migration ledger status and a manual runner for /admin/v1/sql/run (superadmin only)."
      />
      <AutoHelpPanel slug={'dashboard.pluto-deploy'} title={'Deploy & Migrations'} description={'Migration ledger status and a manual runner for /admin/v1/sql/run (superadmin only).'} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Migration status</CardTitle>
          <Button size="sm" variant="outline" onClick={refreshHealth} disabled={loadingHealth}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loadingHealth ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {healthErr && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{healthErr}</AlertDescription>
            </Alert>
          )}
          {health && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={health.status === "ok" ? "default" : "destructive"}>{health.status}</Badge>
                <span className="text-sm text-muted-foreground">
                  {applied.length} applied · current: <code>{health.migrations?.current ?? "—"}</code>
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {authProbes.map(([name, r]) => (
                  <Badge key={name} variant={r.ok ? "secondary" : "destructive"} title={r.error ?? ""}>
                    {r.ok ? "✔" : "✘"} {name}{r.code ? ` (${r.code})` : ""}
                  </Badge>
                ))}
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer">Applied migrations ({applied.length})</summary>
                <ul className="mt-2 font-mono text-xs space-y-0.5 max-h-64 overflow-auto">
                  {applied.map((n) => (<li key={n}>{n}</li>))}
                </ul>
              </details>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" /> Manual SQL runner — <code>/admin/v1/sql/run</code>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea rows={8} className="font-mono text-xs" value={sql} onChange={(e) => setSql(e.target.value)} />
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={readOnly} onCheckedChange={(v) => setReadOnly(!!v)} /> read_only
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={confirmDestructive} onCheckedChange={(v) => setConfirmDestructive(!!v)} disabled={readOnly} />
              <Label className="text-sm">confirm_destructive</Label>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={allowDangerous} onCheckedChange={(v) => setAllowDangerous(!!v)} disabled={readOnly} />
              <Label className="text-sm">allow_dangerous (DROP/ALTER/…)</Label>
            </label>
            <Button size="sm" onClick={runSql} disabled={running || !sql.trim()}>
              <Play className="h-4 w-4 mr-2" /> Run
            </Button>
          </div>
          {!readOnly && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Write mode is enabled. DROP/ALTER/TRUNCATE/REVOKE/RENAME still require <code>allow_dangerous</code>.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4" /> Real deploy — pushMigrations → uploadBundle → verifyDeploy
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="ws-id">Workspace ID <span className="text-muted-foreground">(slug or UUID; 2–128 chars, alphanumeric / _ / -)</span></Label>
            <Input
              id="ws-id"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="e.g. projectbest or 02504262-b997-408d-bdc7-f50c3066238b"
              className={!workspaceId || workspaceIdValid ? "" : "border-destructive"}
            />
            {workspaceId && !workspaceIdValid && (
              <p className="text-xs text-destructive">Invalid — must start alphanumeric and only contain letters, digits, _ or -.</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="bundle">Bundle .zip</Label>
            <Input id="bundle" type="file" accept=".zip,application/zip"
              onChange={(e) => setBundleFile(e.target.files?.[0] ?? null)} />
            {bundleFile && (
              <p className="text-xs text-muted-foreground">{bundleFile.name} — {(bundleFile.size / 1024).toFixed(1)} KB</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="bundle-sql">Migration SQL (runs before upload)</Label>
            <Textarea id="bundle-sql" rows={4} className="font-mono text-xs" value={bundleSql} onChange={(e) => setBundleSql(e.target.value)} />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Label className="text-sm">Max retries per step:</Label>
            <Input type="number" min={0} max={5} value={maxRetries} onChange={(e) => setMaxRetries(Math.max(0, Math.min(5, Number(e.target.value) || 0)))} className="w-20" />
            <Button size="sm" variant="outline" onClick={runEnsureInfra} disabled={deployBusy !== null}>
              <Wrench className="h-4 w-4 mr-2" /> Ensure infra (bucket)
            </Button>
            <Button size="sm" onClick={runFullDeploy} disabled={deployBusy !== null || !workspaceIdValid || !bundleFile}>
              <Rocket className="h-4 w-4 mr-2" /> Run full deploy
            </Button>
            <Button size="sm" variant="outline" onClick={refreshPostHealth} disabled={deployBusy !== null || !workspaceIdValid}>
              <Activity className="h-4 w-4 mr-2" /> Refresh health
            </Button>
            {deployBusy && <span className="text-xs text-muted-foreground">running {deployBusy}…</span>}
          </div>

          {deployError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{deployError}</AlertDescription>
            </Alert>
          )}

          {infraResult && (
            <div className="border rounded-md p-3 text-xs space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant={infraResult.ok ? "secondary" : "destructive"}>{infraResult.ok ? "infra ok" : "infra failed"}</Badge>
                <span className="text-muted-foreground">Ensure infra result</span>
              </div>
              <ul className="space-y-1">
                {infraResult.steps.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <Badge variant={s.ok ? "secondary" : "destructive"}>{s.ok ? "✓" : "✗"}</Badge>
                    <span><b>{s.label}</b> — {s.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {deployResult && (
            <div className="border rounded-md p-3 text-xs space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={deployResult.ok ? "secondary" : "destructive"}>{deployResult.ok ? "deploy ok" : "deploy failed"}</Badge>
                <span className="text-muted-foreground">workspace: <code>{deployResult.workspaceId}</code> · total {deployResult.totalMs}ms</span>
              </div>
              {deployResult.liveUrls && (
                <div className="rounded border bg-muted/30 p-2 space-y-1">
                  <div className="font-medium">Live endpoints</div>
                  <div><span className="text-muted-foreground">runtime:</span> <code className="break-all">{deployResult.liveUrls.functionsHealth}</code></div>
                  <div><span className="text-muted-foreground">bootstrap:</span> <code className="break-all">{deployResult.liveUrls.bootstrapInvoke}</code></div>
                </div>
              )}
              {deployResult.steps.map((s, i) => (
                <details key={i} open={!s.ok} className="border rounded p-2">
                  <summary className="cursor-pointer flex items-center gap-2">
                    <Badge variant={s.ok ? "secondary" : "destructive"}>{s.ok ? "✓" : "✗"}</Badge>
                    <b>{s.label}</b>
                    <span className="text-muted-foreground">({s.attempts.length} attempt{s.attempts.length === 1 ? "" : "s"})</span>
                  </summary>
                  <div className="mt-2 space-y-2">
                    {s.attempts.map((a, j) => (
                      <div key={j} className="border rounded p-2 bg-muted/40">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={a.ok ? "secondary" : "destructive"}>attempt {a.attempt}</Badge>
                          <span className="text-muted-foreground">{a.startedAt} · {a.latencyMs}ms</span>
                        </div>
                        <div className="mb-1"><b>detail:</b> {a.detail}</div>
                        {a.debug && (
                          <details>
                            <summary className="cursor-pointer">HTTP debug</summary>
                            <pre className="mt-1 overflow-auto bg-background p-2 rounded">{JSON.stringify(a.debug, null, 2)}</pre>
                          </details>
                        )}
                      </div>
                    ))}
                    {s.result && (
                      <details>
                        <summary className="cursor-pointer">step result</summary>
                        <pre className="mt-1 overflow-auto bg-muted p-2 rounded">{s.result}</pre>
                      </details>
                    )}
                  </div>
                </details>
              ))}
              {!deployResult.ok && (
                <Button size="sm" onClick={runFullDeploy} disabled={deployBusy !== null}>
                  <RefreshCw className="h-4 w-4 mr-2" /> Retry with same bundle
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>


      <Card>
        <CardHeader><CardTitle>Request / response log</CardTitle></CardHeader>
        <CardContent>
          {logs.length === 0 && <p className="text-sm text-muted-foreground">Nothing run yet.</p>}
          <ul className="space-y-3">
            {logs.map((l, i) => (
              <li key={i} className="border rounded-md p-3 text-xs">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={l.status >= 200 && l.status < 300 ? "secondary" : "destructive"}>{l.status || "ERR"}</Badge>
                  <span className="text-muted-foreground">{l.ts} · {l.duration_ms}ms</span>
                </div>
                <details>
                  <summary className="cursor-pointer">request</summary>
                  <pre className="mt-1 overflow-auto bg-muted p-2 rounded">{JSON.stringify(l.request, null, 2)}</pre>
                </details>
                <details open>
                  <summary className="cursor-pointer">response</summary>
                  <pre className="mt-1 overflow-auto bg-muted p-2 rounded">{JSON.stringify(l.response, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
