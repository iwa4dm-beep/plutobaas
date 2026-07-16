// Pluto Auto-Deploy Studio — 360° One-Click Import → Wire → Live.
//
// Phase G (this file):
//   1. Approval step — SQL/env/bundle review modal before deploy
//   2. Rollback — one-click revert to prior successful bundle (same session)
//   3. Deployment history panel — persistent localStorage-backed log
//   4. Env vars / secrets step — collected, encoded, and appended as SQL upserts
//   5. Detailed health-check UI — endpoint-by-endpoint status + latency + reason
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Rocket, Github, Link as LinkIcon, FileArchive, Loader2, CheckCircle2,
  XCircle, Copy, ExternalLink, RefreshCw, Globe, Sparkles,
  ChevronRight, ChevronDown, ScrollText, History, Undo2, KeyRound,
  Plus, Trash2, Eye, EyeOff, ShieldCheck, Activity, AlertCircle,
  Download, UserCheck, Radio,
} from "lucide-react";

import { analyzeZip } from "@/lib/autoconnect/analyzer";
import { verifyZip } from "@/lib/autoconnect/zip-verify";
import { buildBundle } from "@/lib/autoconnect/bundler";
import { loadRepoAsFile } from "@/lib/autoconnect/github-loader";
import { deployAll, type DeployAllResult, type DeployStepLog } from "@/lib/pluto/vps-deployer.functions";
import { RequireWorkspace } from "@/components/pluto/RequireWorkspace";
import { useWorkspace } from "@/lib/pluto/workspace-context";
import type { AnalyzeResult, IntegrationPlan } from "@/lib/autoconnect/types";
import {
  loadAutoDeployHistory, saveAutoDeployEntry, clearAutoDeployHistory,
  extractHealth, downloadAutoDeployReport,
  type AutoDeployHistoryEntry, type HealthSummary, type EndpointCheck, type StepEvent,
} from "@/lib/pluto/auto-deploy-history";
import { useAuth } from "@/lib/pluto/auth-context";

export const Route = createFileRoute("/dashboard/auto-deploy")({
  head: () => ({
    meta: [
      { title: "Auto-Deploy Studio — Pluto BaaS" },
      { name: "description", content: "GitHub, Git URL অথবা ZIP দিয়ে project দিন — approval, env vars, rollback, health-check সহ ৩৬০° deploy।" },
      { property: "og:title", content: "Auto-Deploy Studio — Pluto BaaS" },
      { property: "og:description", content: "One-click project import → analyze → wire to Pluto BaaS → live URL." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AutoDeployPage,
});

type SourceKind = "github" | "giturl" | "zip";
type Phase = "source" | "analyzing" | "planning" | "bundling" | "awaiting-approval" | "deploying" | "live" | "error";
type EnvVar = { key: string; value: string; secret: boolean };
type PendingDeploy = {
  slug: string;
  sql: string;
  contentBase64: string;
  bundlePath: string;
  bundleSize: number;
  analyze: AnalyzeResult;
  plan: IntegrationPlan;
  envVars: EnvVar[];
  source: SourceKind;
  sourceRef: string;
  isRollback: boolean;
};

// Known pipeline step order — used for real-time progression streaming
// while the `deployAll` server function is executing.
const PIPELINE_STEPS: Array<{ key: string; label: string }> = [
  { key: "ensureInfra", label: "Ensure infrastructure" },
  { key: "push-migrations", label: "Apply migrations" },
  { key: "upload-bundle", label: "Upload frontend bundle" },
  { key: "verify-deploy", label: "Verify deploy" },
  { key: "unpack-serve", label: "Unpack & serve" },
  { key: "activate-service", label: "Activate bootstrap function" },
  { key: "health-check", label: "Health check" },
];

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function planFromAnalyze(a: AnalyzeResult): IntegrationPlan {
  return {
    tables: a.backend.tables.map((t) => ({ name: t.name, columns: t.columns, rls: "owner" as const })),
    endpoints: a.backend.routes.slice(0, 100).map((r) => ({
      laravel: `${r.method} ${r.uri}`,
      pluto: `/rest/v3/${r.uri.replace(/^\/+/, "").replace(/\{([^}]+)\}/g, ":$1")}`,
      kind: "rest" as const,
    })),
    frontendRewrites: [],
    envMap: {},
    storageBuckets: a.backend.storageDisks.map((d) => ({ name: d, public: false })),
    auth: { source: a.backend.authGuard ?? "sanctum", target: "pluto_jwt", notes: "auto" },
    risks: [],
  };
}

/** Build an SQL suffix that upserts env vars into admin.project_env for the
 *  workspace's default project. Wrapped in a DO block so a missing table
 *  won't fail the migration. */
function envVarsToSql(workspaceId: string, envVars: EnvVar[]): string {
  const rows = envVars.filter((e) => e.key.trim()).map((e) => {
    const k = e.key.trim().replace(/'/g, "''");
    const v = e.value.replace(/'/g, "''");
    return `      insert into admin.project_env (project_id, key, value, is_secret) values (pid, '${k}', '${v}', ${e.secret})
        on conflict (project_id, key) do update set value = excluded.value, is_secret = excluded.is_secret;`;
  }).join("\n");
  if (!rows) return "";
  const wid = workspaceId.replace(/'/g, "''");
  return `\n-- Auto-Deploy Studio: env vars\ndo $$
declare pid uuid;
begin
  select id into pid from admin.projects where workspace_id = '${wid}' order by created_at asc limit 1;
  if pid is not null then
${rows}
  end if;
exception when undefined_table then
  raise notice 'admin.project_env table missing — env vars skipped';
end $$;\n`;
}

function AutoDeployPage() {
  return (
    <RequireWorkspace>
      <AutoDeployInner />
    </RequireWorkspace>
  );
}

function AutoDeployInner() {
  const { active } = useWorkspace();
  const { session } = useAuth();
  const workspaceId = active?.id ?? "";
  const approverEmail = session?.user?.email ?? "operator";
  const deploy = useServerFn(deployAll);

  // Source form
  const [source, setSource] = useState<SourceKind>("github");
  const [ghRepo, setGhRepo] = useState("");
  const [ghRef, setGhRef] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [file, setFile] = useState<File | null>(null);

  // Env vars step
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);

  // Pipeline state
  const [phase, setPhase] = useState<Phase>("source");
  const [analyze, setAnalyze] = useState<AnalyzeResult | null>(null);
  const [plan, setPlan] = useState<IntegrationPlan | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [deployResult, setDeployResult] = useState<DeployAllResult | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [slug, setSlug] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDeploy | null>(null);
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [history, setHistory] = useState<AutoDeployHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Real-time streaming
  const [streamEvents, setStreamEvents] = useState<StepEvent[]>([]);
  const [runningStepIdx, setRunningStepIdx] = useState<number>(-1);
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // In-memory rollback anchor — bundle bytes for last successful deploy in this session.
  const lastSuccessRef = useRef<PendingDeploy | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHistory(loadAutoDeployHistory());
    const on = () => setHistory(loadAutoDeployHistory());
    window.addEventListener("pluto:auto-deploy-history:changed", on);
    return () => window.removeEventListener("pluto:auto-deploy-history:changed", on);
  }, []);

  const log = useCallback((m: string) => {
    setLogs((l) => [...l, `[${new Date().toLocaleTimeString()}] ${m}`]);
  }, []);

  const resetAll = () => {
    setPhase("source"); setAnalyze(null); setPlan(null); setLogs([]);
    setDeployResult(null); setErrorMsg(null); setExpanded({});
    setPending(null); setHealth(null);
    setStreamEvents([]); setRunningStepIdx(-1);
    if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }
  };

  const acquireFile = async (): Promise<{ file: File; sourceRef: string }> => {
    if (source === "zip") {
      if (!file) throw new Error("ZIP ফাইল নির্বাচন করুন");
      return { file, sourceRef: file.name };
    }
    if (source === "github") {
      if (!ghRepo.trim()) throw new Error("GitHub repo দিন (owner/repo)");
      log(`Fetching GitHub repo ${ghRepo}${ghRef ? ` @ ${ghRef}` : ""}…`);
      const f = await loadRepoAsFile(ghRepo.trim(), ghRef.trim() || undefined);
      return { file: f, sourceRef: `${ghRepo}${ghRef ? `@${ghRef}` : ""}` };
    }
    if (!gitUrl.trim()) throw new Error("Git repo URL দিন");
    log(`Fetching git URL ${gitUrl}${gitRef ? ` @ ${gitRef}` : ""}…`);
    const f = await loadRepoAsFile(gitUrl.trim(), gitRef.trim() || undefined);
    return { file: f, sourceRef: `${gitUrl}${gitRef ? `@${gitRef}` : ""}` };
  };

  /** Phase 1–4: prepare and stop at approval. */
  const prepare = async () => {
    if (!workspaceId) { toast.error("Workspace select করুন"); return; }
    resetAll();
    try {
      setPhase("analyzing");
      const { file: acquiredFile, sourceRef } = await acquireFile();
      if (acquiredFile.size > 200 * 1024 * 1024) throw new Error("Source > 200MB");
      log(`✓ Source acquired (${(acquiredFile.size / 1024 / 1024).toFixed(1)} MB)`);

      const guessedSlug =
        source === "github" ? ghRepo.replace(/^.*\//, "").toLowerCase()
        : source === "giturl" ? (gitUrl.match(/\/([^/]+?)(?:\.git)?$/)?.[1] ?? "app").toLowerCase()
        : acquiredFile.name.replace(/\.zip$/i, "").toLowerCase();
      const finalSlug = `${guessedSlug.replace(/[^a-z0-9-]+/g, "-").slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}`;
      setSlug(finalSlug);
      log(`Slug: ${finalSlug}`);

      const zip = await JSZip.loadAsync(acquiredFile);
      const v = await verifyZip(zip);
      log(v.ok ? `✓ Integrity: ${v.message}` : `⚠ Integrity: ${v.message}`);

      log("Analyzing project structure…");
      const a = await analyzeZip(acquiredFile, log);
      setAnalyze(a);
      log(`✓ ${a.backend.tables.length} tables · ${a.backend.routes.length} routes · ${a.frontend.apiCallSites.length} API sites`);

      setPhase("planning");
      const p = planFromAnalyze(a);
      setPlan(p);
      log(`✓ Plan: ${p.tables.length} tables · ${p.endpoints.length} endpoints · ${p.storageBuckets.length} buckets`);

      setPhase("bundling");
      log("Building deployment bundle (frontend rewrite + migrations)…");
      const { frontend, migrations } = await buildBundle(zip, a, p);
      const migrationText = await migrations.text().catch(() => "");
      let sql = "";
      try {
        const mzip = await JSZip.loadAsync(migrations);
        sql = (await mzip.file("001_pluto_auto.sql")?.async("string")) ?? "";
      } catch { /* ignore */ }
      if (!sql) sql = migrationText;
      if (!sql || sql.length < 20) throw new Error("Generated SQL empty");

      const envSuffix = envVarsToSql(workspaceId, envVars);
      if (envSuffix) {
        sql += envSuffix;
        log(`✓ ${envVars.filter(e => e.key.trim()).length} env vars appended to migration`);
      }

      const b64 = await blobToBase64(frontend);
      const bundlePath = `sites/${finalSlug}/${finalSlug}.zip`;
      log(`✓ Bundle ready — ${(frontend.size / 1024).toFixed(0)} KB · SQL ${(sql.length / 1024).toFixed(1)} KB`);

      setPending({
        slug: finalSlug, sql, contentBase64: b64, bundlePath, bundleSize: frontend.size,
        analyze: a, plan: p, envVars: [...envVars], source, sourceRef, isRollback: false,
      });
      setPhase("awaiting-approval");
      log("⏸ Awaiting approval — review and confirm to deploy.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg); log(`✗ ${msg}`); setPhase("error");
    }
  };

  /** Phase 5: confirm & deploy. */
  const confirmDeploy = async (payload: PendingDeploy) => {
    setPhase("deploying");
    const approvedAt = Date.now();
    log(payload.isRollback
      ? `▶ Rollback confirmed by ${approverEmail} — redeploying previous bundle…`
      : `▶ Approved by ${approverEmail} — deploying…`);

    // Start real-time step progression stream. We don't have server-side
    // SSE for deployAll, so drive an optimistic timeline that advances
    // through the known pipeline while the RPC is in-flight. When the
    // real result arrives, we reconcile with actual step outcomes.
    const events: StepEvent[] = [];
    const pushEvent = (ev: StepEvent) => {
      events.push(ev);
      setStreamEvents([...events]);
    };
    setStreamEvents([]);
    setRunningStepIdx(0);
    pushEvent({ ts: Date.now(), key: PIPELINE_STEPS[0].key, label: PIPELINE_STEPS[0].label, status: "running" });
    let idx = 0;
    streamTimerRef.current = setInterval(() => {
      if (idx >= PIPELINE_STEPS.length - 1) return;
      const prev = PIPELINE_STEPS[idx];
      pushEvent({ ts: Date.now(), key: prev.key, label: prev.label, status: "ok", detail: "in-progress" });
      idx += 1;
      setRunningStepIdx(idx);
      pushEvent({ ts: Date.now(), key: PIPELINE_STEPS[idx].key, label: PIPELINE_STEPS[idx].label, status: "running" });
    }, 900);

    try {
      const result = await deploy({
        data: {
          workspaceId,
          sql: payload.sql,
          bundlePath: payload.bundlePath,
          contentBase64: payload.contentBase64,
          bucket: "deployments",
          label: `${payload.isRollback ? "rollback" : "auto-deploy"}-${payload.slug}`,
          maxRetries: 2,
          ensureInfra: true,
        },
      });

      if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }

      // Reconcile: replace optimistic stream with real per-step events.
      const realEvents: StepEvent[] = result.steps.map((s) => ({
        ts: Date.now(),
        key: s.key,
        label: s.label,
        status: s.ok ? "ok" : "fail",
        detail: s.attempts.at(-1)?.detail ?? "",
      }));
      setStreamEvents(realEvents);
      setRunningStepIdx(-1);

      setDeployResult(result);
      for (const s of result.steps) {
        log(`${s.ok ? "✓" : "✗"} ${s.label}${s.attempts.at(-1)?.detail ? ` — ${s.attempts.at(-1)!.detail}` : ""}`);
      }
      const h = extractHealth(result);
      setHealth(h);
      if (!result.ok) throw new Error("Deploy pipeline reported failure");
      if (h && !h.overallOk) throw new Error(`Health check failed — ${h.endpoints.filter(e => !e.ok).length} endpoint(s) unhealthy`);
      log(`✅ Live in ${(result.totalMs / 1000).toFixed(1)}s`);
      setPhase("live");

      const liveUrl = `https://${payload.slug}.apps.timescard.cloud`;
      saveAutoDeployEntry({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        workspaceId,
        slug: payload.slug,
        source: payload.source,
        sourceRef: payload.sourceRef,
        ok: result.ok,
        totalMs: result.totalMs,
        liveUrl,
        tables: payload.analyze.backend.tables.length,
        routes: payload.analyze.backend.routes.length,
        bundlePath: payload.bundlePath,
        sqlPreview: payload.sql.slice(0, 2048),
        envKeys: payload.envVars.filter((e) => e.key.trim()).map((e) => e.key.trim()),
        steps: result.steps.map((s) => ({
          key: s.key, label: s.label, ok: s.ok, attempts: s.attempts.length,
          detail: s.attempts.at(-1)?.detail ?? "",
        })),
        health: h,
        isRollback: payload.isRollback,
        approver: approverEmail,
        approvedAt,
        rollbackOf: payload.isRollback ? lastSuccessRef.current?.slug ?? null : null,
        stepEvents: realEvents,
      });
      lastSuccessRef.current = payload;
    } catch (e) {
      if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }
      // Mark the currently-running step as failed in the stream.
      if (events.length > 0) {
        const last = events[events.length - 1];
        if (last.status === "running") {
          last.status = "fail";
          last.detail = e instanceof Error ? e.message : String(e);
          setStreamEvents([...events]);
        }
      }
      setRunningStepIdx(-1);
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg); log(`✗ ${msg}`); setPhase("error");
      // Persist failed run too for visibility
      saveAutoDeployEntry({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        workspaceId,
        slug: payload.slug,
        source: payload.source,
        sourceRef: payload.sourceRef,
        ok: false,
        totalMs: 0,
        liveUrl: null,
        tables: payload.analyze.backend.tables.length,
        routes: payload.analyze.backend.routes.length,
        bundlePath: payload.bundlePath,
        sqlPreview: payload.sql.slice(0, 2048),
        envKeys: payload.envVars.filter((e) => e.key.trim()).map((e) => e.key.trim()),
        steps: [], health: null, isRollback: payload.isRollback,
        approver: approverEmail,
        approvedAt,
        rollbackOf: payload.isRollback ? lastSuccessRef.current?.slug ?? null : null,
        stepEvents: events,
      });
    }
  };

  const rollback = () => {
    const prev = lastSuccessRef.current;
    if (!prev) { toast.error("এই session-এ আগের সফল deploy নেই"); return; }
    // Confirm + redeploy the same bundle
    setPending({ ...prev, isRollback: true });
    setPhase("awaiting-approval");
    setSlug(prev.slug);
    setAnalyze(prev.analyze); setPlan(prev.plan);
    log(`↶ Rollback prepared → ${prev.slug}`);
  };

  const liveUrl = useMemo(() => slug ? `https://${slug}.apps.timescard.cloud` : null, [slug]);
  const busy = phase === "analyzing" || phase === "planning" || phase === "bundling" || phase === "deploying";
  const canRun = !busy && phase !== "awaiting-approval";

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Rocket className="h-6 w-6 text-primary" />
            Auto-Deploy Studio
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Approval, env vars, rollback ও endpoint health-check সহ ৩৬০° deploy — GitHub / Git URL / ZIP থেকে live URL।
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastSuccessRef.current && phase !== "awaiting-approval" && phase !== "deploying" && (
            <button onClick={rollback} className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 px-3 py-2 text-sm hover:bg-amber-500/20">
              <Undo2 className="h-4 w-4" /> Rollback
            </button>
          )}
          <button onClick={() => setShowHistory((v) => !v)} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
            <History className="h-4 w-4" /> History ({history.length})
          </button>
          {phase === "live" && (
            <button onClick={resetAll} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
              <RefreshCw className="h-4 w-4" /> নতুন deploy
            </button>
          )}
        </div>
      </header>

      {/* Stepper */}
      <div className="flex items-center gap-2 text-xs flex-wrap">
        {(["source","analyzing","planning","bundling","awaiting-approval","deploying","live"] as Phase[]).map((p, i, arr) => {
          const order = arr;
          const currentIdx = order.indexOf(phase);
          const done = currentIdx > i;
          const active = phase === p;
          const label = p === "awaiting-approval" ? "approve" : p;
          return (
            <div key={p} className="flex items-center gap-2">
              <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${
                done ? "bg-emerald-500/20 text-emerald-500" :
                active ? "bg-primary text-primary-foreground" :
                "bg-muted text-muted-foreground"
              }`}>
                {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <span className={active ? "font-medium" : "text-muted-foreground"}>{label}</span>
              {i < arr.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            </div>
          );
        })}
      </div>

      {/* Source picker */}
      <section className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex gap-2">
          {([
            { k: "github", label: "GitHub", icon: Github },
            { k: "giturl", label: "Git URL", icon: LinkIcon },
            { k: "zip", label: "ZIP upload", icon: FileArchive },
          ] as const).map(({ k, label, icon: Icon }) => (
            <button key={k} onClick={() => setSource(k)} disabled={!canRun}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm border transition-colors ${
                source === k ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"
              }`}>
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        {source === "github" && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input className="sm:col-span-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="owner/repo" value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} disabled={!canRun}/>
            <input className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="branch / tag / sha (optional)" value={ghRef} onChange={(e) => setGhRef(e.target.value)} disabled={!canRun}/>
          </div>
        )}
        {source === "giturl" && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input className="sm:col-span-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="https://github.com/owner/repo" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} disabled={!canRun}/>
            <input className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="ref (optional)" value={gitRef} onChange={(e) => setGitRef(e.target.value)} disabled={!canRun}/>
          </div>
        )}
        {source === "zip" && (
          <div>
            <input ref={fileInput} type="file" accept=".zip" className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={!canRun}/>
            <button onClick={() => fileInput.current?.click()} disabled={!canRun}
              className="w-full rounded-md border-2 border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors">
              <FileArchive className="mx-auto mb-2 h-6 w-6" />
              {file ? `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)` : "Click to select .zip (max 200 MB)"}
            </button>
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-border">
          <div className="text-xs text-muted-foreground">
            Workspace: <span className="font-mono">{active?.slug ?? "—"}</span>
          </div>
          <button onClick={prepare} disabled={!canRun || !workspaceId}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {phase === "live" ? "আবার prepare" : phase === "error" ? "Retry" : "Analyze & Prepare"}
          </button>
        </div>
      </section>

      {/* Env vars step */}
      <EnvVarsSection envVars={envVars} setEnvVars={setEnvVars} disabled={!canRun} />

      {/* Approval modal */}
      {phase === "awaiting-approval" && pending && (
        <ApprovalPanel
          pending={pending}
          onCancel={() => { setPending(null); setPhase("source"); log("✗ Deploy cancelled by user"); }}
          onConfirm={() => confirmDeploy(pending)}
        />
      )}

      {/* Live URL card */}
      {phase === "live" && liveUrl && (
        <section className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-5 space-y-3">
          <div className="flex items-center gap-2 text-emerald-500">
            <CheckCircle2 className="h-5 w-5" />
            <span className="font-semibold">
              ✅ {pending?.isRollback ? "Rollback সফল" : "Live — deploy সফল"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 min-w-0 rounded-md bg-background px-3 py-2 text-sm font-mono truncate border border-border">{liveUrl}</code>
            <button onClick={() => { navigator.clipboard.writeText(liveUrl); toast.success("Copied"); }}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent flex items-center gap-1.5">
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
            <a href={liveUrl} target="_blank" rel="noreferrer"
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" /> Open
            </a>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs">
            <Stat label="Tables" value={analyze?.backend.tables.length ?? 0} />
            <Stat label="Routes" value={analyze?.backend.routes.length ?? 0} />
            <Stat label="Deploy time" value={`${((deployResult?.totalMs ?? 0) / 1000).toFixed(1)}s`} />
            <Stat label="Steps ok" value={`${deployResult?.steps.filter((s) => s.ok).length ?? 0}/${deployResult?.steps.length ?? 0}`} />
          </div>
          <div className="pt-2 border-t border-emerald-500/20 flex flex-wrap gap-2 text-xs">
            <a href="/dashboard/custom-domains" className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 hover:bg-accent">
              <Globe className="h-3.5 w-3.5" /> Attach custom domain
            </a>
            <a href="/dashboard/logs-explorer" className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 hover:bg-accent">
              <ScrollText className="h-3.5 w-3.5" /> View logs
            </a>
            {history[0] && (
              <button
                data-testid="export-report-live"
                onClick={() => { downloadAutoDeployReport(history[0]); toast.success("Report downloaded"); }}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 hover:bg-accent">
                <Download className="h-3.5 w-3.5" /> Export report
              </button>
            )}
          </div>
        </section>
      )}

      {/* Real-time streaming panel — while deploying */}
      {(phase === "deploying" || (streamEvents.length > 0 && phase !== "live")) && (
        <StreamPanel events={streamEvents} runningIdx={runningStepIdx} />
      )}

      {/* Error banner */}
      {phase === "error" && errorMsg && (
        <section className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive flex items-start gap-2">
          <XCircle className="h-5 w-5 shrink-0" />
          <div>
            <div className="font-semibold">Deploy failed</div>
            <div className="text-destructive/80 mt-0.5">{errorMsg}</div>
            {lastSuccessRef.current && (
              <button onClick={rollback} className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 py-1.5 text-xs hover:bg-destructive/10">
                <Undo2 className="h-3.5 w-3.5" /> Rollback to last success
              </button>
            )}
          </div>
        </section>
      )}

      {/* Health check panel */}
      {health && <HealthCheckPanel health={health} />}

      {/* Per-step deploy result */}
      {deployResult && (
        <section className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">Deploy pipeline steps</div>
          <ul className="divide-y divide-border">
            {deployResult.steps.map((s) => (
              <StepRow key={s.key} step={s} open={!!expanded[s.key]} onToggle={() => setExpanded((e) => ({ ...e, [s.key]: !e[s.key] }))} />
            ))}
          </ul>
        </section>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <section className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm font-medium flex items-center gap-2">
            <ScrollText className="h-4 w-4" /> Activity log
          </div>
          <div className="max-h-72 overflow-y-auto p-4 font-mono text-xs space-y-0.5">
            {logs.map((l, i) => <div key={i} className="text-muted-foreground">{l}</div>)}
          </div>
        </section>
      )}

      {/* Audit trail panel — always visible when there is history */}
      {history.length > 0 && <AuditTrailPanel history={history} />}

      {/* History panel */}
      {showHistory && <HistoryPanel history={history} onClear={() => { clearAutoDeployHistory(); toast.success("History cleared"); }} />}
    </div>
  );
}

// ─── Env vars ────────────────────────────────────────────────────────────
function EnvVarsSection({ envVars, setEnvVars, disabled }: { envVars: EnvVar[]; setEnvVars: (v: EnvVar[]) => void; disabled: boolean }) {
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const add = () => setEnvVars([...envVars, { key: "", value: "", secret: true }]);
  const remove = (i: number) => setEnvVars(envVars.filter((_, idx) => idx !== i));
  const update = (i: number, patch: Partial<EnvVar>) =>
    setEnvVars(envVars.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="h-4 w-4" /> Secrets & environment variables
          <span className="text-xs text-muted-foreground font-normal">({envVars.filter(e => e.key.trim()).length} defined)</span>
        </div>
        <button onClick={add} disabled={disabled} className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Deploy-এর সময় এই key/value গুলো <code className="text-[10px] bg-muted px-1 rounded">admin.project_env</code> এ upsert হবে। Secret চিহ্নিতগুলো masked থাকবে ও client-side শুধু approval-এ দেখানো হবে।
      </p>
      {envVars.length === 0 ? (
        <div className="text-xs text-muted-foreground italic py-2">এখনো কোনো env var যোগ করা হয়নি।</div>
      ) : (
        <div className="space-y-2">
          {envVars.map((e, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto_auto] gap-2 items-center">
              <input className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm font-mono"
                placeholder="KEY_NAME" value={e.key}
                onChange={(ev) => update(i, { key: ev.target.value.replace(/[^A-Za-z0-9_]/g, "").toUpperCase() })}
                disabled={disabled}/>
              <input className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm font-mono"
                type={e.secret && !reveal[i] ? "password" : "text"}
                placeholder="value" value={e.value}
                onChange={(ev) => update(i, { value: ev.target.value })}
                disabled={disabled}/>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input type="checkbox" checked={e.secret} onChange={(ev) => update(i, { secret: ev.target.checked })} disabled={disabled}/>
                secret
              </label>
              <button onClick={() => setReveal((r) => ({ ...r, [i]: !r[i] }))} disabled={disabled}
                className="rounded-md border border-border p-1.5 hover:bg-accent disabled:opacity-50" title={reveal[i] ? "Hide" : "Reveal"}>
                {reveal[i] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <button onClick={() => remove(i)} disabled={disabled}
                className="rounded-md border border-border p-1.5 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Approval ────────────────────────────────────────────────────────────
function ApprovalPanel({ pending, onCancel, onConfirm }: { pending: PendingDeploy; onCancel: () => void; onConfirm: () => void }) {
  const [showSql, setShowSql] = useState(false);
  const definedEnv = pending.envVars.filter((e) => e.key.trim());
  return (
    <section className="rounded-xl border-2 border-amber-500/50 bg-amber-500/5 p-5 space-y-4">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
        <ShieldCheck className="h-5 w-5" />
        <span className="font-semibold">Approval required — কনফার্ম করলে migrations apply ও live publish হবে</span>
      </div>
      {pending.isRollback && (
        <div className="rounded-md bg-amber-500/10 border border-amber-500/30 p-2 text-xs text-amber-700 dark:text-amber-300 flex items-center gap-2">
          <Undo2 className="h-4 w-4" /> এটি একটি rollback — আগের সফল bundle পুনরায় deploy হবে।
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <Stat label="Slug" value={pending.slug} />
        <Stat label="Bundle" value={`${(pending.bundleSize / 1024).toFixed(0)} KB`} />
        <Stat label="Tables" value={pending.analyze.backend.tables.length} />
        <Stat label="Routes" value={pending.analyze.backend.routes.length} />
      </div>
      <div className="text-xs space-y-1.5">
        <div className="font-medium">Source</div>
        <div className="font-mono text-muted-foreground">{pending.source} · {pending.sourceRef}</div>
      </div>
      <div className="text-xs space-y-1.5">
        <div className="font-medium">Env vars ({definedEnv.length})</div>
        {definedEnv.length === 0 ? (
          <div className="text-muted-foreground italic">কোনো env var নেই</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {definedEnv.map((e) => (
              <span key={e.key} className="inline-flex items-center gap-1 rounded bg-background border border-border px-2 py-0.5 font-mono">
                {e.secret && <KeyRound className="h-3 w-3" />}
                {e.key}={e.secret ? "•••" : e.value.slice(0, 20)}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="text-xs">
        <button onClick={() => setShowSql((v) => !v)} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          {showSql ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          SQL preview ({(pending.sql.length / 1024).toFixed(1)} KB)
        </button>
        {showSql && (
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-background border border-border p-2 font-mono text-[11px] whitespace-pre-wrap">
            {pending.sql.slice(0, 8000)}{pending.sql.length > 8000 ? `\n… (+${pending.sql.length - 8000} chars)` : ""}
          </pre>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-amber-500/20">
        <button onClick={onCancel} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">Cancel</button>
        <button onClick={onConfirm} className="flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-emerald-500">
          <CheckCircle2 className="h-4 w-4" /> Confirm & deploy
        </button>
      </div>
    </section>
  );
}

// ─── Health check ────────────────────────────────────────────────────────
function HealthCheckPanel({ health }: { health: HealthSummary }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3 text-sm font-medium flex items-center gap-2">
        <Activity className="h-4 w-4" />
        Endpoint health
        <span className={`ml-auto text-xs ${health.overallOk ? "text-emerald-500" : "text-destructive"}`}>
          {health.overallOk ? `✓ ${health.endpoints.length}/${health.endpoints.length} passing` : `${health.endpoints.filter(e => e.ok).length}/${health.endpoints.length} passing`}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {health.endpoints.map((e, i) => <EndpointRow key={i} endpoint={e} />)}
      </ul>
    </section>
  );
}

function EndpointRow({ endpoint }: { endpoint: EndpointCheck }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent/40">
        {endpoint.ok
          ? <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
          : <AlertCircle className="h-4 w-4 text-destructive shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="text-sm flex items-center gap-2">
            <span className="font-medium">{endpoint.label}</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted">{endpoint.method}</span>
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${endpoint.ok ? "bg-emerald-500/15 text-emerald-600" : "bg-destructive/15 text-destructive"}`}>
              {endpoint.status || "ERR"}
            </span>
            {endpoint.latencyMs > 0 && <span className="text-xs text-muted-foreground">{endpoint.latencyMs}ms</span>}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">{endpoint.url}</div>
          {endpoint.failReason && <div className="text-xs text-destructive mt-0.5">{endpoint.failReason}</div>}
        </div>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {open && (
        <div className="px-4 pb-3">
          <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[11px] font-mono whitespace-pre-wrap">{endpoint.bodySnippet || "(empty)"}</pre>
        </div>
      )}
    </li>
  );
}

// ─── History panel ───────────────────────────────────────────────────────
function HistoryPanel({ history, onClear }: { history: AutoDeployHistoryEntry[]; onClear: () => void }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3 text-sm font-medium flex items-center gap-2">
        <History className="h-4 w-4" /> Deployment history
        <span className="text-xs text-muted-foreground">({history.length})</span>
        {history.length > 0 && (
          <button onClick={onClear} className="ml-auto text-xs text-muted-foreground hover:text-destructive">Clear all</button>
        )}
      </div>
      {history.length === 0 ? (
        <div className="p-6 text-sm text-muted-foreground text-center">এখনো কোনো deploy history নেই।</div>
      ) : (
        <ul className="divide-y divide-border">
          {history.map((h) => <HistoryRow key={h.id} entry={h} />)}
        </ul>
      )}
    </section>
  );
}

function HistoryRow({ entry }: { entry: AutoDeployHistoryEntry }) {
  const [open, setOpen] = useState(false);
  const date = new Date(entry.timestamp);
  return (
    <li>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent/40">
        {entry.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-destructive" />}
        <div className="flex-1 min-w-0">
          <div className="text-sm flex items-center gap-2 flex-wrap">
            <span className="font-medium font-mono truncate">{entry.slug}</span>
            {entry.isRollback && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600">rollback</span>}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted uppercase">{entry.source}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {date.toLocaleString()} · {entry.tables} tables · {entry.routes} routes · {(entry.totalMs / 1000).toFixed(1)}s
          </div>
        </div>
        {entry.liveUrl && (
          <a href={entry.liveUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
            className="text-xs text-primary hover:underline flex items-center gap-1 shrink-0">
            <ExternalLink className="h-3 w-3" /> Open
          </a>
        )}
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-2 text-xs">
          <div>Source: <span className="font-mono text-muted-foreground">{entry.sourceRef}</span></div>
          <div>Bundle path: <span className="font-mono text-muted-foreground">{entry.bundlePath}</span></div>
          {entry.envKeys.length > 0 && (
            <div>Env keys: <span className="font-mono text-muted-foreground">{entry.envKeys.join(", ")}</span></div>
          )}
          {entry.steps.length > 0 && (
            <div className="rounded-md border border-border bg-background p-2 space-y-1">
              {entry.steps.map((s) => (
                <div key={s.key} className="flex items-center gap-2">
                  {s.ok ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> : <XCircle className="h-3 w-3 text-destructive" />}
                  <span className="font-medium">{s.label}</span>
                  <span className="text-muted-foreground truncate">— {s.detail}</span>
                </div>
              ))}
            </div>
          )}
          {entry.health && (
            <div className="rounded-md border border-border bg-background p-2 space-y-1">
              <div className="font-medium">Health</div>
              {entry.health.endpoints.map((e, i) => (
                <div key={i} className="flex items-center gap-2">
                  {e.ok ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> : <XCircle className="h-3 w-3 text-destructive" />}
                  <span>{e.label}</span>
                  <span className="text-muted-foreground font-mono">{e.status} · {e.latencyMs}ms</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ─── Shared ──────────────────────────────────────────────────────────────
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md bg-background border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold mt-0.5 truncate">{value}</div>
    </div>
  );
}

function StepRow({ step, open, onToggle }: { step: DeployStepLog; open: boolean; onToggle: () => void }) {
  const last = step.attempts.at(-1);
  return (
    <li>
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent/40">
        {step.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-destructive" />}
        <div className="flex-1 min-w-0">
          <div className="text-sm">{step.label}</div>
          {last?.detail && <div className="text-xs text-muted-foreground truncate">{last.detail}</div>}
        </div>
        <div className="text-xs text-muted-foreground">{step.attempts.length} attempt{step.attempts.length !== 1 ? "s" : ""}</div>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-2 text-xs">
          {step.attempts.map((a, i) => (
            <div key={i} className="rounded-md border border-border bg-background p-2">
              <div className="flex items-center justify-between">
                <span className={a.ok ? "text-emerald-500" : "text-destructive"}>
                  {a.ok ? "✓" : "✗"} attempt {a.attempt} · {a.latencyMs}ms
                </span>
                <span className="text-muted-foreground">{a.startedAt}</span>
              </div>
              <div className="mt-1 text-muted-foreground break-words">{a.detail}</div>
              {a.debug && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted-foreground">HTTP {a.debug.status} · {a.debug.method} {a.debug.url}</summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">{a.debug.resBodyPreview}</pre>
                </details>
              )}
            </div>
          ))}
          {step.result && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">Result</summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">{step.result}</pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}
