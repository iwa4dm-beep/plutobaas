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
  Download, UserCheck, Radio, Bell, Webhook, FileJson, FolderTree,
} from "lucide-react";

import { analyzeZip } from "@/lib/autoconnect/analyzer";
import { verifyZip } from "@/lib/autoconnect/zip-verify";
import { buildBundle } from "@/lib/autoconnect/bundler";
import { loadRepoAsFile } from "@/lib/autoconnect/github-loader";
import { deployAll, diagnoseServedSite, probeLiveUrl, type DeployAllResult, type DeployStepLog, type LiveUrlProbe, type ServedSiteDiagnostics } from "@/lib/pluto/vps-deployer.functions";
import { DeploySummaryChecksPanel } from "@/components/auto-deploy/DeploySummaryChecks";
import { BuildLogsPanel } from "@/components/auto-deploy/BuildLogsPanel";
import { DeploymentSettingsPanel } from "@/components/auto-deploy/DeploymentSettingsPanel";
import { RecommendationsPanel } from "@/components/auto-deploy/RecommendationsPanel";
import { CustomDomainsPanel } from "@/components/auto-deploy/CustomDomainsPanel";
import { OneClickFixPanel } from "@/components/auto-deploy/OneClickFixPanel";
import { MigrationErrorCard, parseMigrationError } from "@/components/auto-deploy/MigrationErrorCard";
import { loadDeploymentSettings } from "@/lib/pluto/deployment-settings";
import { getUpstream } from "@/lib/pluto/upstream";
import { describeError } from "@/lib/pluto/live";
import { useServerAction } from "@/lib/pluto/use-server-action";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";

import { RequireWorkspace } from "@/components/pluto/RequireWorkspace";
import { useWorkspace } from "@/lib/pluto/workspace-context";
import type { AnalyzeResult, IntegrationPlan } from "@/lib/autoconnect/types";
import {
  loadAutoDeployHistory, saveAutoDeployEntry, clearAutoDeployHistory,
  extractHealth, downloadAutoDeployReport,
  type AutoDeployHistoryEntry, type HealthSummary, type EndpointCheck, type StepEvent,
} from "@/lib/pluto/auto-deploy-history";
import {
  ALL_EVENTS, dispatchWebhookEvent, loadWebhooks, saveWebhooks,
  loadWebhookLog, loadEndpointStatus, newWebhookId,
  type WebhookConfig, type WebhookEvent, type WebhookLogEntry,
  type EndpointStatus,
} from "@/lib/pluto/auto-deploy-webhooks";
import {
  PAYLOAD_SCHEMAS, buildSchemaBundle,
} from "@/lib/pluto/auto-deploy-webhook-schemas";
import { useAuth } from "@/lib/pluto/auth-context";
import { pingUpstream, type UpstreamPreflight } from "@/lib/pluto/upstream-preflight.functions";

// Self-healing: max auto-retry attempts on transient deploy failure
const MAX_AUTO_RETRIES = 1;
// Heuristics: which error messages are worth an automatic retry
function isTransientDeployError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("timeout") || m.includes("network") || m.includes("fetch") ||
    m.includes("econnreset") || m.includes("503") || m.includes("502") ||
    m.includes("504") || m.includes("temporarily") || m.includes("unavailable") ||
    m.includes("health check failed")
  );
}

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
  { key: "verify-ssl", label: "Verify SSL / HTTPS" },
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
  alter table if exists admin.project_env add column if not exists is_secret boolean not null default false;
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
  const diagnoseServedSiteFn = useServerFn(diagnoseServedSite);

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
  const [preflight, setPreflight] = useState<UpstreamPreflight | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [servedDiagnostics, setServedDiagnostics] = useState<ServedSiteDiagnostics | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const pingUpstreamFn = useServerFn(pingUpstream);

  // Served-site probe config (persisted in localStorage). Overrides the
  // PLUTO_SERVED_SITE_URL / PLUTO_SERVED_SITE_URL_TEMPLATE env values per-deploy.
  const [servedSiteUrl, setServedSiteUrl] = useState<string>("");
  const [servedSiteUrlTemplate, setServedSiteUrlTemplate] = useState<string>("");
  const [strictServedSite, setStrictServedSite] = useState<boolean>(true);
  const [defaultBranch, setDefaultBranch] = useState<string>("main");
  const refreshSettingsFromStore = useCallback(() => {
    if (typeof window === "undefined") return;
    const s = loadDeploymentSettings(workspaceId);
    setServedSiteUrl(s.servedSiteUrl);
    setServedSiteUrlTemplate(s.servedSiteUrlTemplate);
    setStrictServedSite(s.strictServedSite);
    setDefaultBranch(s.defaultBranch || "main");
  }, [workspaceId]);
  useEffect(() => {
    refreshSettingsFromStore();
    if (typeof window === "undefined") return;
    const handler = () => refreshSettingsFromStore();
    window.addEventListener("pluto:deployment-settings:changed", handler);
    return () => window.removeEventListener("pluto:deployment-settings:changed", handler);
  }, [refreshSettingsFromStore]);
  const saveServedSiteConfig = (next: { url?: string; template?: string; strict?: boolean }) => {
    if (typeof window === "undefined") return;
    try {
      if (next.url !== undefined) { window.localStorage.setItem("pluto:servedSiteUrl", next.url); setServedSiteUrl(next.url); }
      if (next.template !== undefined) { window.localStorage.setItem("pluto:servedSiteUrlTemplate", next.template); setServedSiteUrlTemplate(next.template); }
      if (next.strict !== undefined) { window.localStorage.setItem("pluto:strictServedSite", next.strict ? "1" : "0"); setStrictServedSite(next.strict); }
    } catch { /* ignore */ }
  };


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

  const runPreflight = useCallback(async () => {
    setPreflightBusy(true);
    try {
      const operatorToken = getUpstream().token || undefined;
      const r = await pingUpstreamFn({ data: { operatorToken } });

      setPreflight(r);
    } catch (e) {
      const info = describeError(e);
      setPreflight({ ok: false, baseUrl: "", tokenSource: "none", checks: [], hint: info.detail ?? info.title });
    } finally { setPreflightBusy(false); }
  }, [pingUpstreamFn]);

  // Auto-run preflight on mount so misconfig surfaces before the user tries to deploy.
  useEffect(() => { runPreflight(); }, [runPreflight]);

  // Prevent stream interval leak on unmount
  useEffect(() => {
    return () => {
      if (streamTimerRef.current) {
        clearInterval(streamTimerRef.current);
        streamTimerRef.current = null;
      }
    };
  }, []);

  const log = useCallback((m: string) => {
    setLogs((l) => [...l, `[${new Date().toLocaleTimeString()}] ${m}`]);
  }, []);

  const resetAll = () => {
    setPhase("source"); setAnalyze(null); setPlan(null); setLogs([]);
    setDeployResult(null); setErrorMsg(null); setExpanded({});
    setPending(null); setHealth(null); setServedDiagnostics(null);
    setStreamEvents([]); setRunningStepIdx(-1);
    if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }
  };

  const diagnosticsAction = useServerAction(diagnoseServedSiteFn, {
    errorTitle: "Diagnostics failed",
    silent: true,
    onSuccess: (r) => {
      setServedDiagnostics(r);
      if (r.ok) toast.success("Served-site mapping OK");
      else toast.warning(r.hint ?? "Served-site mapping issue found");
    },
  });
  const runServedDiagnostics = useCallback(async () => {
    if (!workspaceId || !slug) {
      toast.error("Workspace/slug missing — deploy বা prepare আগে চালান");
      return;
    }
    setDiagnosticsBusy(true);
    try {
      await diagnosticsAction.run({ data: { workspaceId, slug } });
    } finally {
      setDiagnosticsBusy(false);
    }
  }, [diagnosticsAction, workspaceId, slug]);


  const acquireFile = async (): Promise<{ file: File; sourceRef: string }> => {
    if (source === "zip") {
      if (!file) throw new Error("ZIP ফাইল নির্বাচন করুন");
      return { file, sourceRef: file.name };
    }
    if (source === "github") {
      if (!ghRepo.trim()) throw new Error("GitHub repo দিন (owner/repo)");
      const effectiveRef = ghRef.trim() || defaultBranch.trim();
      log(`Fetching GitHub repo ${ghRepo}${effectiveRef ? ` @ ${effectiveRef}` : ""}…`);
      const f = await loadRepoAsFile(ghRepo.trim(), effectiveRef || undefined);
      return { file: f, sourceRef: `${ghRepo}${effectiveRef ? `@${effectiveRef}` : ""}` };
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
      dispatchWebhookEvent("approval.awaiting", {
        slug: finalSlug, source, sourceRef,
        tables: a.backend.tables.length, routes: a.backend.routes.length,
        envKeys: envVars.filter((e) => e.key.trim()).map((e) => e.key.trim()),
        message: "Deploy is awaiting operator approval",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg); log(`✗ ${msg}`); setPhase("error");
      dispatchWebhookEvent("deploy.failed", { message: msg, phase: "prepare" });
    }
  };

  /** One attempt of the deploy pipeline (used both for initial run and self-healing retry). */
  const runDeployAttempt = async (payload: PendingDeploy, attempt: number): Promise<DeployAllResult> => {
    // Start real-time step progression stream. `deployAll` is a single RPC,
    // so we drive an optimistic timeline that advances through the known
    // pipeline while it's in-flight, and reconcile with real results below.
    const events: StepEvent[] = [];
    const pushEvent = (ev: StepEvent) => {
      events.push(ev);
      setStreamEvents([...events]);
      if (ev.status === "running") {
        dispatchWebhookEvent("step.running", { slug: payload.slug, step: ev.key, label: ev.label, attempt });
      }
    };
    setStreamEvents([]);
    setRunningStepIdx(0);
    pushEvent({ ts: Date.now(), key: PIPELINE_STEPS[0].key, label: PIPELINE_STEPS[0].label, status: "running" });
    let idx = 0;
    // Clear any dangling timer before starting a fresh interval
    if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }
    streamTimerRef.current = setInterval(() => {
      if (idx >= PIPELINE_STEPS.length - 1) {
        // Reached the last step — stop the interval so it doesn't leak
        if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }
        return;
      }
      const prev = PIPELINE_STEPS[idx];
      pushEvent({ ts: Date.now(), key: prev.key, label: prev.label, status: "ok", detail: "in-progress" });
      idx += 1;
      setRunningStepIdx(idx);
      pushEvent({ ts: Date.now(), key: PIPELINE_STEPS[idx].key, label: PIPELINE_STEPS[idx].label, status: "running" });
    }, 900);

    try {
      const operatorToken = getUpstream().token || undefined;
      const result = await deploy({
        data: {
          workspaceId,
          sql: payload.sql,
          bundlePath: payload.bundlePath,
          contentBase64: payload.contentBase64,
          bucket: "deployments",
          label: `${payload.isRollback ? "rollback" : "auto-deploy"}-${payload.slug}${attempt > 1 ? `-retry${attempt - 1}` : ""}`,
          maxRetries: 2,
          ensureInfra: true,
          operatorToken,
          ...(servedSiteUrl.trim() ? { servedSiteUrl: servedSiteUrl.trim() } : {}),
          ...(servedSiteUrlTemplate.trim() ? { servedSiteUrlTemplate: servedSiteUrlTemplate.trim() } : {}),
          strictServedSite,
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
      for (const s of result.steps) {
        dispatchWebhookEvent(s.ok ? "step.ok" : "step.fail", {
          slug: payload.slug, step: s.key, label: s.label, attempt,
          detail: s.attempts.at(-1)?.detail ?? "",
        });
      }
      return result;
    } catch (e) {
      if (streamTimerRef.current) { clearInterval(streamTimerRef.current); streamTimerRef.current = null; }
      // Mark the currently-running step as failed in the stream.
      if (events.length > 0) {
        const last = events[events.length - 1];
        if (last.status === "running") {
          last.status = "fail";
          last.detail = e instanceof Error ? e.message : String(e);
          setStreamEvents([...events]);
          dispatchWebhookEvent("step.fail", {
            slug: payload.slug, step: last.key, label: last.label, attempt,
            detail: last.detail,
          });
        }
      }
      setRunningStepIdx(-1);
      throw e;
    }
  };

  /** Phase 5: confirm & deploy — with self-healing retry on transient errors. */
  const confirmDeploy = async (payload: PendingDeploy) => {
    setPhase("deploying");
    const approvedAt = Date.now();
    log(payload.isRollback
      ? `▶ Rollback confirmed by ${approverEmail} — redeploying previous bundle…`
      : `▶ Approved by ${approverEmail} — deploying…`);
    dispatchWebhookEvent(payload.isRollback ? "rollback.started" : "approval.confirmed", {
      slug: payload.slug, approver: approverEmail, source: payload.source, sourceRef: payload.sourceRef,
    });

    let attempt = 0;
    let result: DeployAllResult | null = null;
    let h: HealthSummary | null = null;
    let lastError: Error | null = null;

    while (attempt <= MAX_AUTO_RETRIES) {
      attempt += 1;
      try {
        if (attempt > 1) {
          log(`↻ Self-healing retry #${attempt - 1}…`);
          dispatchWebhookEvent("deploy.retry", { slug: payload.slug, attempt, reason: lastError?.message });
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
        result = await runDeployAttempt(payload, attempt);
        setDeployResult(result);
        for (const s of result.steps) {
          log(`${s.ok ? "✓" : "✗"} ${s.label}${s.attempts.at(-1)?.detail ? ` — ${s.attempts.at(-1)!.detail}` : ""}`);
        }
        h = extractHealth(result);
        setHealth(h);
        if (!result.ok) throw new Error("Deploy pipeline reported failure");
        if (h && !h.overallOk) throw new Error(`Health check failed — ${h.endpoints.filter(e => !e.ok).length} endpoint(s) unhealthy`);
        lastError = null;
        break; // success
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        const canRetry = attempt <= MAX_AUTO_RETRIES && isTransientDeployError(lastError.message);
        if (!canRetry) break;
        log(`⚠ Attempt ${attempt} failed (${lastError.message}) — auto-retrying…`);
      }
    }

    if (result && !lastError) {
      log(`✅ Pipeline complete in ${(result.totalMs / 1000).toFixed(1)}s${attempt > 1 ? ` (after ${attempt - 1} auto-retry)` : ""}`);
      setPhase("live");
      // Prefer the URL the backend actually resolved + probed. Fall back to the
      // legacy fabricated slug host only for display continuity, and mark it
      // clearly as "not-served-yet" when the backend confirms it isn't reachable.
      const resolvedLiveUrl =
        result.liveUrls?.resolvedSite ||
        result.liveUrls?.servedSite ||
        `https://${payload.slug}.apps.timescard.cloud`;
      const liveUrl = resolvedLiveUrl;
      const realEvents: StepEvent[] = result.steps.map((s) => ({
        ts: Date.now(), key: s.key, label: s.label,
        status: s.ok ? "ok" : "fail",
        detail: s.attempts.at(-1)?.detail ?? "",
      }));
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
      dispatchWebhookEvent(payload.isRollback ? "rollback.completed" : "deploy.published", {
        slug: payload.slug, liveUrl, totalMs: result.totalMs, attempts: attempt,
        approver: approverEmail,
      });
    } else {
      const msg = lastError?.message ?? "Deploy failed";
      setErrorMsg(msg); log(`✗ ${msg}`); setPhase("error");
      dispatchWebhookEvent("deploy.failed", {
        slug: payload.slug, message: msg, attempts: attempt,
        isRollback: payload.isRollback,
      });
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
        steps: result?.steps.map((s) => ({
          key: s.key, label: s.label, ok: s.ok, attempts: s.attempts.length,
          detail: s.attempts.at(-1)?.detail ?? "",
        })) ?? [],
        health: h, isRollback: payload.isRollback,
        approver: approverEmail,
        approvedAt,
        rollbackOf: payload.isRollback ? lastSuccessRef.current?.slug ?? null : null,
        stepEvents: [],
      });
    }
  };

  const rollback = () => {
    const prev = lastSuccessRef.current;
    if (!prev) { toast.error("এই session-এ আগের সফল deploy নেই"); return; }
    setPending({ ...prev, isRollback: true });
    setPhase("awaiting-approval");
    setSlug(prev.slug);
    setAnalyze(prev.analyze); setPlan(prev.plan);
    log(`↶ Rollback prepared → ${prev.slug}`);
    dispatchWebhookEvent("approval.awaiting", {
      slug: prev.slug, message: "Rollback awaiting approval", isRollback: true,
    });
  };



  // The URL displayed after "Live". Prefer the backend-resolved served-site URL
  // (from PLUTO_SERVED_SITE_URL or the sandbox worker's unpack webRoot) — only
  // fall back to the slug-based hostname (which has no DNS/nginx wiring today).
  const liveUrl = useMemo(() => {
    const fromResult = deployResult?.liveUrls?.resolvedSite || deployResult?.liveUrls?.servedSite;
    if (fromResult) return fromResult;
    return slug ? `https://${slug}.apps.timescard.cloud` : null;
  }, [slug, deployResult]);
  const bootstrapInvokeUrl = deployResult?.liveUrls?.bootstrapInvoke ?? null;
  // Backend probe outcome (populated during deployAll). Client re-probes on demand.
  const initialProbe = deployResult?.liveUrls?.servedSiteProbe ?? null;
  const [liveProbe, setLiveProbe] = useState<LiveUrlProbe | null>(initialProbe);
  const [probing, setProbing] = useState(false);
  useEffect(() => { setLiveProbe(deployResult?.liveUrls?.servedSiteProbe ?? null); }, [deployResult]);
  const probeAction = useServerAction(probeLiveUrl, {
    errorTitle: "Probe failed",
    silent: true,
    onSuccess: (r) => {
      setLiveProbe(r);
      if (r.reachable) toast.success(`Live URL reachable — HTTP ${r.status}`);
      else if (r.httpOk) toast.error(`Live URL returned HTTP ${r.status}, but the deployed app is not routed`);
      else toast.error(`Live URL unreachable — HTTP ${r.status || "network error"}`);
    },
  });
  const runProbe = useCallback(async () => {
    if (!liveUrl) return;
    setProbing(true);
    try {
      await probeAction.run({ data: { url: liveUrl } });
    } finally {
      setProbing(false);
    }
  }, [liveUrl, probeAction]);
  const servedHint = deployResult?.liveUrls?.servedHint ?? null;
  const backendSaysServed = deployResult?.liveUrls?.served === true;
  const isReachable = liveProbe ? liveProbe.reachable : backendSaysServed;
  const routeMismatch = Boolean(liveProbe && liveProbe.httpOk && !liveProbe.reachable);
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

      {/* Upstream preflight banner — surfaces auth / reachability issues before deploy */}
      {preflight && !preflight.ok && (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                  Upstream Pluto backend not ready — deploys will fail
                </div>
                <p className="text-xs text-amber-700/90 dark:text-amber-200/90 mt-1">
                  {preflight.hint ?? "Preflight probe reported an error."}
                </p>
                <div className="mt-2 text-[11px] font-mono text-amber-800/80 dark:text-amber-200/80 space-y-0.5">
                  <div>base: {preflight.baseUrl || "(unset)"}</div>
                  <div>token: {preflight.tokenSource}</div>
                  {preflight.checks.map((c) => (
                    <div key={c.label}>
                      {c.ok ? "✓" : "✗"} {c.label} — HTTP {c.status || "ERR"} ({c.latencyMs}ms)
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <button onClick={runPreflight} disabled={preflightBusy}
              className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs hover:bg-amber-500/20 disabled:opacity-50">
              {preflightBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Re-check
            </button>
          </div>
        </section>
      )}
      {preflight && preflight.ok && (
        <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="h-3.5 w-3.5" />
          Upstream reachable & authorized ({preflight.tokenSource}) — ready to deploy.
          <button onClick={runPreflight} disabled={preflightBusy} className="text-muted-foreground hover:text-foreground underline underline-offset-2">
            re-check
          </button>
        </div>
      )}

      {/* Served-site probe config — overrides PLUTO_SERVED_SITE_URL / _TEMPLATE env for this browser */}
      <details className="rounded-xl border border-border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Served-site probe config
          <span className="text-xs text-muted-foreground font-normal">
            {servedSiteUrl || servedSiteUrlTemplate ? "(override active)" : "(using env defaults + autodetect)"}
          </span>
        </summary>
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Health check-এর served-site probe এই URL থেকে হবে। default হিসেবে প্রতিটি deploy একই primary frontend
            <code className="font-mono"> https://app.timescard.app</code> এ flip হবে; empty রাখলে env/autodetect fallback ব্যবহার হবে।
            Bundle unpack হওয়ার পর served-site fail হলে deploy auto-heal চালাবে; তবুও serve না হলে strict mode deploy fail করবে।
          </p>
          <div>
            <label className="text-xs text-muted-foreground">Explicit URL (highest priority)</label>
            <input
              type="text"
              value={servedSiteUrl}
              onChange={(e) => saveServedSiteConfig({ url: e.target.value })}
              placeholder="https://app.timescard.app"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              URL template — <code className="font-mono">{"{slug}"}</code> placeholder
            </label>
            <input
              type="text"
              value={servedSiteUrlTemplate}
              onChange={(e) => saveServedSiteConfig({ template: e.target.value })}
              placeholder="optional, e.g. https://api.timescard.cloud/sites/{slug}"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={strictServedSite}
              onChange={(e) => saveServedSiteConfig({ strict: e.target.checked })}
              className="rounded"
            />
            <span>Strict mode — served-site 404 fails the deploy after auto-heal attempts</span>
          </label>
        </div>
      </details>



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
              placeholder={`branch / tag / sha (default: ${defaultBranch})`} value={ghRef} onChange={(e) => setGhRef(e.target.value)} disabled={!canRun}/>
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
          onCancel={() => {
            setPending(null); setPhase("source"); log("✗ Deploy cancelled by user");
            dispatchWebhookEvent("approval.cancelled", { slug: pending.slug, approver: approverEmail });
          }}
          onConfirm={() => confirmDeploy(pending)}
        />
      )}

      {/* Live URL card */}
      {phase === "live" && liveUrl && (
        <section
          className={`rounded-xl border p-5 space-y-3 ${
            isReachable
              ? "border-emerald-500/40 bg-emerald-500/5"
              : "border-amber-500/40 bg-amber-500/5"
          }`}
        >
          <div className={`flex items-center gap-2 ${isReachable ? "text-emerald-500" : "text-amber-500"}`}>
            {isReachable ? <CheckCircle2 className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}
            <span className="font-semibold">
              {isReachable
                ? (pending?.isRollback ? "✅ Rollback সফল — সাইট live" : "✅ Live — deploy সফল")
                : (pending?.isRollback
                    ? "⚠ Rollback pipeline সফল — কিন্তু সাইট এখনো served হয়নি"
                    : "⚠ Deploy pipeline সফল — কিন্তু সাইট এখনো served হয়নি")}
            </span>
          </div>

          {!isReachable && (
            <div className="text-xs text-amber-600 dark:text-amber-400 leading-relaxed">
              Bundle upload, migrations, bootstrap সব সফল — কিন্তু নিচের URL-এ {routeMismatch ? "সঠিক deployed frontend route হচ্ছে না" : "এখনো কোনো frontend serve হচ্ছে না"}
              {liveProbe ? ` (HTTP ${liveProbe.status || "network"})` : ""}.
              {servedHint ? ` ${servedHint}` : ""}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 min-w-0 rounded-md bg-background px-3 py-2 text-sm font-mono truncate border border-border">{liveUrl}</code>
            <button onClick={() => { navigator.clipboard.writeText(liveUrl); toast.success("Copied"); }}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent flex items-center gap-1.5">
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
            <button
              onClick={runProbe}
              disabled={probing}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent flex items-center gap-1.5 disabled:opacity-60">
              <RefreshCw className={`h-3.5 w-3.5 ${probing ? "animate-spin" : ""}`} /> Re-check
            </button>
            <button
              onClick={runServedDiagnostics}
              disabled={diagnosticsBusy}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent flex items-center gap-1.5 disabled:opacity-60">
              {diagnosticsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderTree className="h-3.5 w-3.5" />}
              Diagnose
            </button>
            <a href={liveUrl} target="_blank" rel="noreferrer"
              className={`rounded-md px-3 py-2 text-sm flex items-center gap-1.5 ${
                isReachable
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border border-border hover:bg-accent"
              }`}>
              <ExternalLink className="h-3.5 w-3.5" /> Open
            </a>
          </div>

          {liveProbe && (
            <div className="text-[11px] text-muted-foreground font-mono">
              Probe: HTTP {liveProbe.status || "-"} · {liveProbe.latencyMs}ms · {liveProbe.contentType ?? "non-html"}
              {liveProbe.httpOk && !liveProbe.reachable ? ` · route mismatch=${liveProbe.routeMismatchReason ?? "wrong-app"}` : ""} · checked just now
              {liveProbe.snippet ? ` · ${liveProbe.snippet.slice(0, 120)}` : ""}
            </div>
          )}

          {bootstrapInvokeUrl && (
            <div className="text-xs text-muted-foreground">
              Verifiable backend endpoint: <a href={bootstrapInvokeUrl} target="_blank" rel="noreferrer" className="underline font-mono">{bootstrapInvokeUrl}</a>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs">
            <Stat label="Tables" value={analyze?.backend.tables.length ?? 0} />
            <Stat label="Routes" value={analyze?.backend.routes.length ?? 0} />
            <Stat label="Deploy time" value={`${((deployResult?.totalMs ?? 0) / 1000).toFixed(1)}s`} />
            <Stat label="Steps ok" value={`${deployResult?.steps.filter((s) => s.ok).length ?? 0}/${deployResult?.steps.length ?? 0}`} />
          </div>
          <div className="pt-2 border-t border-border/50 flex flex-wrap gap-2 text-xs">
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

      {/* Server-action errors (probe / diagnostics) */}
      <ErrorBanner error={probeAction.error} onDismiss={probeAction.reset} />
      <ErrorBanner error={diagnosticsAction.error} onDismiss={diagnosticsAction.reset} />

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
      {health && (
        <HealthCheckPanel
          health={health}
          diagnostics={servedDiagnostics}
          diagnosticsBusy={diagnosticsBusy}
          onRunDiagnostics={runServedDiagnostics}
        />
      )}

      {/* Deployment settings — Phase 3 */}
      <DeploymentSettingsPanel workspaceId={workspaceId} />

      {/* Summary + Checks */}
      {deployResult && <DeploySummaryChecksPanel result={deployResult} />}

      {/* Recommendations — Phase 4 */}
      <RecommendationsPanel result={deployResult ?? null} workspaceId={workspaceId} />

      {/* Build logs — Phase 2 */}
      {deployResult && <BuildLogsPanel result={deployResult} />}

      {/* Custom domains — Phase 5 */}
      <CustomDomainsPanel workspaceId={workspaceId} currentSlug={slug} />

      {/* One-click VPS repair — auto-heal preflight + remediation buttons */}
      <OneClickFixPanel slug={slug} />


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

      {/* Configurable webhooks — notifications for approval / steps / failures / rollback / publish */}
      <WebhooksSection />

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
function HealthCheckPanel({
  health,
  diagnostics,
  diagnosticsBusy,
  onRunDiagnostics,
}: {
  health: HealthSummary;
  diagnostics: ServedSiteDiagnostics | null;
  diagnosticsBusy: boolean;
  onRunDiagnostics: () => void;
}) {
  const passing = health.endpoints.filter((e) => e.ok).length;
  const warnings = health.endpoints.filter((e) => !e.ok && e.severity === "warning").length;
  const errors = health.endpoints.filter((e) => !e.ok && e.severity !== "warning").length;
  const statusText = errors > 0
    ? `${passing}/${health.endpoints.length} passing · ${errors} error${errors === 1 ? "" : "s"}`
    : warnings > 0
      ? `${passing}/${health.endpoints.length} passing · ${warnings} warning${warnings === 1 ? "" : "s"}`
      : `✓ ${health.endpoints.length}/${health.endpoints.length} passing`;

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3 text-sm font-medium flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Endpoint health
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={`text-xs ${errors > 0 ? "text-destructive" : warnings > 0 ? "text-amber-500" : "text-emerald-500"}`}>
            {statusText}
          </span>
          <button
            onClick={onRunDiagnostics}
            disabled={diagnosticsBusy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-60"
          >
            {diagnosticsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderTree className="h-3.5 w-3.5" />}
            Diagnose served-site
          </button>
        </div>
      </div>
      <ul className="divide-y divide-border">
        {health.endpoints.map((e, i) => <EndpointRow key={i} endpoint={e} />)}
      </ul>
      {diagnostics && <ServedSiteDiagnosticsPanel diagnostics={diagnostics} />}
    </section>
  );
}

function ServedSiteDiagnosticsPanel({ diagnostics }: { diagnostics: ServedSiteDiagnostics }) {
  const p = diagnostics.paths;
  const rows = p ? [
    { label: `/var/lib/pluto/sites/${diagnostics.workspaceId}`, ok: p.workspaceDirExists, detail: p.workspaceDir },
    { label: `/var/lib/pluto/sites/${diagnostics.slug}`, ok: p.slugPathExists && (p.slugTargetsWorkspace || p.slugPath === p.workspaceDir), detail: p.slugIsSymlink ? `symlink → ${p.slugTarget ?? "?"}` : (p.slugPathExists ? "exists but not symlink" : "missing") },
    { label: `/var/lib/pluto/sites/${diagnostics.workspaceId}/${diagnostics.slug}`, ok: p.nestedSlugPathExists, detail: p.nestedSlugIsSymlink ? `symlink → ${p.nestedSlugTarget ?? "?"}` : (p.nestedSlugPathExists ? "exists" : "missing") },
    { label: "current symlink", ok: p.currentExists && p.currentIsSymlink && p.currentIndexExists, detail: p.currentIsSymlink ? `current → ${p.currentTarget ?? "?"}; index.html ${p.currentIndexExists ? "exists" : "missing"}` : (p.currentExists ? "exists but not symlink" : "missing") },
    { label: "current.json", ok: p.currentJsonExists && p.currentJsonValid && p.currentJsonMatchesSlug !== false && p.currentJsonMatchesWorkspace !== false, detail: p.currentJsonValid ? `slug=${p.currentJsonSlug ?? "-"}; workspace=${p.currentJsonWorkspaceId ?? "-"}` : (p.currentJsonExists ? "invalid JSON" : "missing") },
  ] : [];

  return (
    <div className={`border-t border-border p-4 space-y-3 ${diagnostics.ok ? "bg-emerald-500/5" : "bg-amber-500/5"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {diagnostics.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertCircle className="h-4 w-4 text-amber-500" />}
          Served-site diagnostics
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${diagnostics.ok ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"}`}>
            {diagnostics.ok ? "OK" : "CHECK"}
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground font-mono">HTTP {diagnostics.sandbox.status || "ERR"} · {diagnostics.sandbox.latencyMs}ms</div>
      </div>
      {diagnostics.hint && <div className="text-xs text-muted-foreground">{diagnostics.hint}</div>}
      {rows.length > 0 ? (
        <div className="grid grid-cols-1 gap-2">
          {rows.map((r) => <DiagnosticRow key={r.label} label={r.label} ok={r.ok} detail={r.detail} />)}
        </div>
      ) : (
        <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[11px] font-mono whitespace-pre-wrap">{diagnostics.sandbox.body ?? "No diagnostics payload returned"}</pre>
      )}
      {p?.errors?.length ? (
        <div className="text-xs font-mono text-amber-600">errors: {p.errors.join(", ")}</div>
      ) : null}
    </div>
  );
}

function DiagnosticRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 text-xs flex items-start gap-2">
      {ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />}
      <div className="min-w-0">
        <div className="font-medium break-words">{label}</div>
        <div className="font-mono text-muted-foreground break-all mt-0.5">{detail}</div>
      </div>
    </div>
  );
}

function EndpointRow({ endpoint }: { endpoint: EndpointCheck }) {
  const [open, setOpen] = useState(false);
  const isWarn = !endpoint.ok && endpoint.severity === "warning";
  const Icon = endpoint.ok ? CheckCircle2 : (isWarn ? AlertCircle : AlertCircle);
  const iconColor = endpoint.ok ? "text-emerald-500" : (isWarn ? "text-amber-500" : "text-destructive");
  const statusColor = endpoint.ok
    ? "bg-emerald-500/15 text-emerald-600"
    : (isWarn ? "bg-amber-500/15 text-amber-600" : "bg-destructive/15 text-destructive");
  const reasonColor = isWarn ? "text-amber-600" : "text-destructive";
  return (
    <li>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent/40">
        <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm flex items-center gap-2">
            <span className="font-medium">{endpoint.label}</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted">{endpoint.method}</span>
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${statusColor}`}>
              {endpoint.status || "ERR"}
            </span>
            {isWarn && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600">WARN</span>}
            {endpoint.latencyMs > 0 && <span className="text-xs text-muted-foreground">{endpoint.latencyMs}ms</span>}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">{endpoint.url}</div>
          {endpoint.failReason && <div className={`text-xs mt-0.5 ${reasonColor}`}>{endpoint.failReason}{isWarn ? " (non-fatal — served-site is downstream infra config)" : ""}</div>}
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
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => { downloadAutoDeployReport(entry); toast.success("Report downloaded"); }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-accent">
              <Download className="h-3 w-3" /> Export report
            </button>
            {entry.approver && (
              <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                <UserCheck className="h-3 w-3" /> {entry.approver}
              </span>
            )}
          </div>
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
              {!a.ok && parseMigrationError(a.detail || "") && (
                <div className="mt-2"><MigrationErrorCard raw={a.detail || ""} /></div>
              )}
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

// ─── Real-time streaming panel ────────────────────────────────────────────
function StreamPanel({ events, runningIdx }: { events: StepEvent[]; runningIdx: number }) {
  return (
    <section className="rounded-xl border border-primary/30 bg-primary/5">
      <div className="border-b border-primary/20 px-4 py-3 text-sm font-medium flex items-center gap-2">
        <Radio className={`h-4 w-4 ${runningIdx >= 0 ? "text-primary animate-pulse" : "text-muted-foreground"}`} />
        Real-time deployment stream
        <span className="ml-auto text-xs text-muted-foreground">{events.length} event{events.length === 1 ? "" : "s"}</span>
      </div>
      <ul className="divide-y divide-primary/10" data-testid="stream-events">
        {events.map((ev, i) => (
          <li key={i} className="px-4 py-2 flex items-center gap-3 text-sm">
            {ev.status === "running" && <Loader2 className="h-4 w-4 text-primary animate-spin" />}
            {ev.status === "ok" && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
            {ev.status === "fail" && <XCircle className="h-4 w-4 text-destructive" />}
            <span className="font-medium">{ev.label}</span>
            {ev.detail && <span className="text-xs text-muted-foreground truncate">— {ev.detail}</span>}
            <span className="ml-auto text-[10px] text-muted-foreground font-mono">{new Date(ev.ts).toLocaleTimeString()}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Audit trail panel ────────────────────────────────────────────────────
function AuditTrailPanel({ history }: { history: AutoDeployHistoryEntry[] }) {
  const entries = history.slice(0, 10);
  return (
    <section className="rounded-xl border border-border bg-card" data-testid="audit-trail">
      <div className="border-b border-border px-4 py-3 text-sm font-medium flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" /> Audit trail
        <span className="text-xs text-muted-foreground">— approvals, env vars used (masked), rollback actions</span>
      </div>
      <ul className="divide-y divide-border">
        {entries.map((e) => {
          const when = new Date(e.approvedAt ?? e.timestamp);
          const kind = e.isRollback ? "rollback" : "deploy";
          return (
            <li key={e.id} className="px-4 py-3 text-xs space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                {e.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <XCircle className="h-3.5 w-3.5 text-destructive" />}
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${e.isRollback ? "bg-amber-500/15 text-amber-600" : "bg-primary/15 text-primary"} uppercase`}>{kind}</span>
                <span className="font-mono">{e.slug}</span>
                {e.rollbackOf && <span className="text-muted-foreground">← <span className="font-mono">{e.rollbackOf}</span></span>}
                <span className="text-muted-foreground">·</span>
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <UserCheck className="h-3 w-3" /> {e.approver ?? "unknown"}
                </span>
                <span className="ml-auto text-muted-foreground font-mono">{when.toLocaleString()}</span>
              </div>
              <div className="flex flex-wrap gap-1 pl-5">
                <span className="text-muted-foreground">Env:</span>
                {e.envKeys.length === 0
                  ? <span className="text-muted-foreground italic">none</span>
                  : e.envKeys.map((k) => (
                      <span key={k} className="inline-flex items-center gap-1 rounded bg-background border border-border px-1.5 py-0.5 font-mono">
                        <KeyRound className="h-2.5 w-2.5" /> {k}=<span className="text-muted-foreground">•••</span>
                      </span>
                    ))
                }
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ─── Configurable webhooks ────────────────────────────────────────────────
function WebhooksSection() {
  const [hooks, setHooks] = useState<WebhookConfig[]>([]);
  const [log, setLog] = useState<WebhookLogEntry[]>([]);
  const [status, setStatus] = useState<Record<string, EndpointStatus>>({});
  const [showLog, setShowLog] = useState(false);
  const [showSchemas, setShowSchemas] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftSecret, setDraftSecret] = useState("");
  const [draftFormat, setDraftFormat] = useState<"json" | "slack" | "discord">("json");
  const [draftEvents, setDraftEvents] = useState<WebhookEvent[]>([...ALL_EVENTS]);

  useEffect(() => {
    setHooks(loadWebhooks());
    setLog(loadWebhookLog());
    setStatus(loadEndpointStatus());
    const on1 = () => setHooks(loadWebhooks());
    const on2 = () => setLog(loadWebhookLog());
    const on3 = () => setStatus(loadEndpointStatus());
    window.addEventListener("pluto:auto-deploy-webhooks:changed", on1);
    window.addEventListener("pluto:auto-deploy-webhook-log:changed", on2);
    window.addEventListener("pluto:auto-deploy-webhook-status:changed", on3);
    return () => {
      window.removeEventListener("pluto:auto-deploy-webhooks:changed", on1);
      window.removeEventListener("pluto:auto-deploy-webhook-log:changed", on2);
      window.removeEventListener("pluto:auto-deploy-webhook-status:changed", on3);
    };
  }, []);

  const persist = (list: WebhookConfig[]) => { saveWebhooks(list); setHooks(list); };

  const addHook = () => {
    if (!draftUrl.trim() || !/^https?:\/\//.test(draftUrl)) { toast.error("Valid https URL দিন"); return; }
    if (draftEvents.length === 0) { toast.error("অন্তত একটি event select করুন"); return; }
    const cfg: WebhookConfig = {
      id: newWebhookId(),
      label: draftLabel.trim() || new URL(draftUrl).host,
      url: draftUrl.trim(),
      secret: draftSecret.trim() || undefined,
      events: [...draftEvents],
      enabled: true,
      format: draftFormat,
      createdAt: Date.now(),
    };
    persist([cfg, ...hooks]);
    setDraftUrl(""); setDraftLabel(""); setDraftSecret("");
    setDraftFormat("json"); setDraftEvents([...ALL_EVENTS]);
    toast.success("Webhook added");
  };

  const testHook = (cfg: WebhookConfig) => {
    // Force-dispatch a synthetic event on this hook only
    const saved = loadWebhooks();
    saveWebhooks([{ ...cfg, events: ["deploy.published"], enabled: true }, ...saved.filter(h => h.id !== cfg.id).map(h => ({ ...h, enabled: false }))]);
    dispatchWebhookEvent("deploy.published", {
      slug: "test-slug", liveUrl: "https://example.test", totalMs: 0,
      message: "Test webhook from Auto-Deploy Studio", approver: "operator",
    });
    // Restore full config
    setTimeout(() => saveWebhooks(saved), 100);
    toast.success(`Test event sent to ${cfg.label}`);
  };


  const toggleEvent = (ev: WebhookEvent) => {
    setDraftEvents((cur) => cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]);
  };

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3 text-sm font-medium flex items-center gap-2 flex-wrap">
        <Webhook className="h-4 w-4" /> Realtime notification webhooks
        <span className="text-xs text-muted-foreground">({hooks.length} configured)</span>
        <button
          onClick={() => setShowSchemas((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <FileJson className="h-3.5 w-3.5" /> Payload schemas
        </button>
        <button
          onClick={() => setShowLog((v) => !v)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <Bell className="h-3.5 w-3.5" /> Delivery log ({log.length})
        </button>
      </div>

      {/* Add form */}
      <div className="p-4 space-y-3 border-b border-border">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
          <input value={draftLabel} onChange={(e) => setDraftLabel(e.target.value)}
            placeholder="Label (e.g. #deploys)" className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"/>
          <input value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)}
            placeholder="https://hooks.slack.com/... or custom endpoint" className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm font-mono"/>
          <select value={draftFormat} onChange={(e) => setDraftFormat(e.target.value as "json" | "slack" | "discord")}
            className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm">
            <option value="json">JSON</option>
            <option value="slack">Slack</option>
            <option value="discord">Discord</option>
          </select>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
          <input value={draftSecret} onChange={(e) => setDraftSecret(e.target.value)}
            placeholder="Signing secret (HMAC-SHA256, optional)" className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm font-mono"
            type="password" autoComplete="off"/>
          <span className="text-[10px] text-muted-foreground self-center px-1">
            Sent as <code className="font-mono">x-pluto-signature: sha256=&lt;hex&gt;</code>
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {ALL_EVENTS.map((ev) => (
            <button key={ev} onClick={() => toggleEvent(ev)}
              className={`text-[10px] font-mono px-2 py-0.5 rounded border ${draftEvents.includes(ev) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
              {ev}
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <button onClick={addHook} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90">
            <Plus className="h-3.5 w-3.5" /> Add webhook
          </button>
        </div>
      </div>

      {/* Existing hooks */}
      {hooks.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground italic">এখনো কোনো webhook যোগ করা হয়নি।</div>
      ) : (
        <ul className="divide-y divide-border">
          {hooks.map((h) => (
            <li key={h.id} className="px-4 py-3 text-xs space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <input type="checkbox" checked={h.enabled}
                  onChange={(e) => persist(hooks.map((x) => x.id === h.id ? { ...x, enabled: e.target.checked } : x))}/>
                <span className="font-medium">{h.label}</span>
                <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-muted">{h.format}</span>
                {h.secret && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-500 flex items-center gap-1">
                    <ShieldCheck className="h-2.5 w-2.5"/> signed
                  </span>
                )}
                {status[h.id] && (
                  <span
                    data-testid={`endpoint-status-${h.id}`}
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                      status[h.id].finalStatus === "delivered" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
                      : status[h.id].finalStatus === "retrying" ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
                      : "border-destructive/40 bg-destructive/10 text-destructive"
                    }`}
                    title={`Last: ${status[h.id].lastEvent} · attempt ${status[h.id].lastAttempt} · ${status[h.id].lastError ?? "ok"}`}>
                    {status[h.id].finalStatus} · try {status[h.id].lastAttempt}/4
                  </span>
                )}
                <span className="text-muted-foreground font-mono truncate flex-1 min-w-0">{h.url}</span>
                <button onClick={() => testHook(h)}
                  className="rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-accent">Test</button>
                <button onClick={() => persist(hooks.filter((x) => x.id !== h.id))}
                  className="rounded-md border border-border p-1 hover:bg-destructive/10 hover:text-destructive">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <div className="flex flex-wrap gap-1 pl-6">
                {h.events.map((ev) => (
                  <span key={ev} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-background border border-border text-muted-foreground">{ev}</span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Payload schemas */}
      {showSchemas && <PayloadSchemasPanel />}

      {/* Delivery log */}
      {showLog && (
        <div className="border-t border-border">
          <div className="px-4 py-2 text-[11px] font-medium text-muted-foreground">Recent deliveries</div>
          {log.length === 0 ? (
            <div className="px-4 pb-3 text-xs text-muted-foreground italic">No deliveries yet.</div>
          ) : (
            <ul className="divide-y divide-border max-h-64 overflow-auto">
              {log.map((e, i) => (
                <li key={i} className="px-4 py-1.5 text-[11px] flex items-center gap-2 font-mono">
                  {e.ok ? <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" /> : <XCircle className="h-3 w-3 text-destructive shrink-0" />}
                  <span className="text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span className="font-semibold">{e.event}</span>
                  <span className="text-muted-foreground truncate">→ {e.webhookLabel}</span>
                  <span className="text-[10px] px-1 rounded bg-muted">try {e.attempt}/{e.maxAttempts}</span>
                  <span className={`text-[10px] px-1 rounded ${
                    e.finalStatus === "delivered" ? "bg-emerald-500/10 text-emerald-500"
                    : e.finalStatus === "retrying" ? "bg-amber-500/10 text-amber-500"
                    : "bg-destructive/10 text-destructive"
                  }`}>{e.finalStatus}</span>
                  <span className="ml-auto text-muted-foreground">{e.status || "—"} · {e.latencyMs}ms</span>
                  {e.error && <span className="text-destructive truncate">{e.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Payload schemas panel ─────────────────────────────────────────────────
function PayloadSchemasPanel() {
  const events = Object.values(PAYLOAD_SCHEMAS);
  const [selected, setSelected] = useState(events[0].event);
  const [view, setView] = useState<"schema" | "example">("example");
  const current = PAYLOAD_SCHEMAS[selected];

  const downloadBundle = () => {
    const bundle = buildSchemaBundle();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "pluto-auto-deploy-webhook-schemas.json";
    a.click(); URL.revokeObjectURL(url);
    toast.success("Schema bundle downloaded");
  };
  const downloadOne = () => {
    const payload = view === "schema" ? current.schema : current.example;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${current.event}.${view}.json`;
    a.click(); URL.revokeObjectURL(url);
  };
  const copyOne = async () => {
    const payload = view === "schema" ? current.schema : current.example;
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    toast.success("Copied to clipboard");
  };

  return (
    <div className="border-t border-border" data-testid="payload-schemas">
      <div className="px-4 py-2 flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-medium text-muted-foreground">
          Payload schemas ({events.length} events)
        </span>
        <button onClick={downloadBundle}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-accent">
          <Download className="h-3 w-3"/> Download all
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-0 border-t border-border">
        <ul className="border-r border-border max-h-80 overflow-auto">
          {events.map((s) => (
            <li key={s.event}>
              <button onClick={() => setSelected(s.event)}
                className={`w-full text-left px-3 py-1.5 text-[11px] font-mono border-l-2 ${
                  selected === s.event ? "border-primary bg-primary/5 text-primary" : "border-transparent text-muted-foreground hover:bg-accent"
                }`}>
                {s.event}
              </button>
            </li>
          ))}
        </ul>
        <div className="p-3 space-y-2 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">{current.title}</span>
            <div className="ml-auto flex gap-1">
              <button onClick={() => setView("example")}
                className={`text-[10px] px-2 py-0.5 rounded border ${view === "example" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
                Example
              </button>
              <button onClick={() => setView("schema")}
                className={`text-[10px] px-2 py-0.5 rounded border ${view === "schema" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>
                Schema
              </button>
              <button onClick={copyOne}
                className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent inline-flex items-center gap-1">
                <Copy className="h-2.5 w-2.5"/> Copy
              </button>
              <button onClick={downloadOne}
                className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-accent inline-flex items-center gap-1">
                <Download className="h-2.5 w-2.5"/> .json
              </button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{current.description}</p>
          <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 border border-border p-2 text-[10.5px] font-mono leading-relaxed">
            {JSON.stringify(view === "schema" ? current.schema : current.example, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}

