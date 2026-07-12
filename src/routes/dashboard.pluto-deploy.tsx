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
import { AlertTriangle, Play, RefreshCw, Rocket, ShieldAlert, Wrench } from "lucide-react";
import { plutoApi } from "@/lib/pluto/upstream";
import { useServerFn } from "@tanstack/react-start";
import { deployAll, ensureDeployInfra, type DeployAllResult, type EnsureInfraResult } from "@/lib/pluto/vps-deployer.functions";

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
