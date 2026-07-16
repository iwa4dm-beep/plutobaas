// Pluto Auto-Deploy Studio — 360° One-Click Import → Wire → Live.
//
// Accepts a project via GitHub connector, Git repo URL, or ZIP upload;
// analyzes it, plans DB + endpoint wiring, builds a deploy bundle, and
// pushes it through the existing `deployAll` orchestrator server fn
// (ensureInfra → pushMigrations → uploadBundle → verifyDeploy →
// unpackServe → activateService → healthCheck) — the same pipeline
// the Auto-Connect Studio uses, but wrapped in a single guided flow
// with three source inputs and a final "live URL" card.
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Rocket, Github, Link as LinkIcon, FileArchive, Loader2, CheckCircle2,
  XCircle, Circle, Copy, ExternalLink, RefreshCw, Globe, Sparkles,
  ChevronRight, ChevronDown, ScrollText,
} from "lucide-react";

import { analyzeZip } from "@/lib/autoconnect/analyzer";
import { verifyZip } from "@/lib/autoconnect/zip-verify";
import { buildBundle } from "@/lib/autoconnect/bundler";
import { loadRepoAsFile } from "@/lib/autoconnect/github-loader";
import { deployAll, type DeployAllResult, type DeployStepLog } from "@/lib/pluto/vps-deployer.functions";
import { RequireWorkspace } from "@/components/pluto/RequireWorkspace";
import { useWorkspace } from "@/lib/pluto/workspace-context";
import type { AnalyzeResult, IntegrationPlan } from "@/lib/autoconnect/types";

export const Route = createFileRoute("/dashboard/auto-deploy")({
  head: () => ({
    meta: [
      { title: "Auto-Deploy Studio — Pluto BaaS" },
      { name: "description", content: "GitHub, Git URL অথবা ZIP দিয়ে project দিন — ধারাবাহিকভাবে analyze, wire এবং live করে দেবে।" },
      { property: "og:title", content: "Auto-Deploy Studio — Pluto BaaS" },
      { property: "og:description", content: "One-click project import → analyze → wire to Pluto BaaS → live URL." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AutoDeployPage,
});

type SourceKind = "github" | "giturl" | "zip";
type Phase = "source" | "analyzing" | "planning" | "bundling" | "deploying" | "live" | "error";

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

function AutoDeployPage() {
  return (
    <RequireWorkspace>
      <AutoDeployInner />
    </RequireWorkspace>
  );
}

function AutoDeployInner() {
  const { active } = useWorkspace();
  const workspaceId = active?.id ?? "";
  const deploy = useServerFn(deployAll);

  const [source, setSource] = useState<SourceKind>("github");
  const [ghRepo, setGhRepo] = useState("");
  const [ghRef, setGhRef] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const [phase, setPhase] = useState<Phase>("source");
  const [analyze, setAnalyze] = useState<AnalyzeResult | null>(null);
  const [plan, setPlan] = useState<IntegrationPlan | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [deployResult, setDeployResult] = useState<DeployAllResult | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [slug, setSlug] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const log = useCallback((m: string) => {
    setLogs((l) => [...l, `[${new Date().toLocaleTimeString()}] ${m}`]);
  }, []);

  const resetAll = () => {
    setPhase("source"); setAnalyze(null); setPlan(null); setLogs([]);
    setDeployResult(null); setErrorMsg(null); setExpanded({});
  };

  const acquireFile = async (): Promise<File> => {
    if (source === "zip") {
      if (!file) throw new Error("ZIP ফাইল নির্বাচন করুন");
      return file;
    }
    if (source === "github") {
      if (!ghRepo.trim()) throw new Error("GitHub repo দিন (owner/repo)");
      log(`Fetching GitHub repo ${ghRepo}${ghRef ? ` @ ${ghRef}` : ""}…`);
      return loadRepoAsFile(ghRepo.trim(), ghRef.trim() || undefined);
    }
    if (!gitUrl.trim()) throw new Error("Git repo URL দিন");
    log(`Fetching git URL ${gitUrl}${gitRef ? ` @ ${gitRef}` : ""}…`);
    return loadRepoAsFile(gitUrl.trim(), gitRef.trim() || undefined);
  };

  const run = async () => {
    if (!workspaceId) { toast.error("Workspace select করুন"); return; }
    resetAll();
    let acquiredFile: File | null = null;
    try {
      // ── Phase 1: acquire source ──────────────────────────────────────
      setPhase("analyzing");
      acquiredFile = await acquireFile();
      if (acquiredFile.size > 200 * 1024 * 1024) throw new Error("Source > 200MB — সমর্থিত সর্বোচ্চ ২০০MB");
      log(`✓ Source acquired (${(acquiredFile.size / 1024 / 1024).toFixed(1)} MB)`);

      // Auto-slug
      const guessedSlug =
        source === "github" ? ghRepo.replace(/^.*\//, "").toLowerCase()
        : source === "giturl" ? (gitUrl.match(/\/([^/]+?)(?:\.git)?$/)?.[1] ?? "app").toLowerCase()
        : acquiredFile.name.replace(/\.zip$/i, "").toLowerCase();
      const finalSlug = `${guessedSlug.replace(/[^a-z0-9-]+/g, "-").slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}`;
      setSlug(finalSlug);
      log(`Slug: ${finalSlug}`);

      // ── Phase 2: verify + analyze ────────────────────────────────────
      const zip = await JSZip.loadAsync(acquiredFile);
      const v = await verifyZip(zip);
      log(v.ok ? `✓ Integrity: ${v.message}` : `⚠ Integrity: ${v.message}`);

      log("Analyzing project structure…");
      const a = await analyzeZip(acquiredFile, log);
      setAnalyze(a);
      log(`✓ ${a.backend.tables.length} tables · ${a.backend.routes.length} routes · ${a.frontend.apiCallSites.length} API sites`);

      // ── Phase 3: plan (heuristic) ────────────────────────────────────
      setPhase("planning");
      const p = planFromAnalyze(a);
      setPlan(p);
      log(`✓ Plan: ${p.tables.length} tables · ${p.endpoints.length} endpoints · ${p.storageBuckets.length} buckets`);

      // ── Phase 4: bundle ──────────────────────────────────────────────
      setPhase("bundling");
      log("Building deployment bundle (frontend rewrite + migrations)…");
      const { frontend, migrations } = await buildBundle(zip, a, p);
      const migrationText = await migrations.text().catch(() => "");
      // Extract SQL from the migrations zip (001_pluto_auto.sql lives inside)
      let sql = "";
      try {
        const mzip = await JSZip.loadAsync(migrations);
        sql = (await mzip.file("001_pluto_auto.sql")?.async("string")) ?? "";
      } catch { /* fall through */ }
      if (!sql) sql = migrationText;
      if (!sql || sql.length < 20) throw new Error("Generated SQL empty — analyzer কোনো migration/table বের করতে পারেনি");
      log(`✓ Bundle ready — frontend ${(frontend.size / 1024).toFixed(0)} KB · SQL ${(sql.length / 1024).toFixed(1)} KB`);

      // ── Phase 5: deploy via existing orchestrator ────────────────────
      setPhase("deploying");
      const b64 = await blobToBase64(frontend);
      const bundlePath = `sites/${finalSlug}/${finalSlug}.zip`;
      log(`Deploying → ${bundlePath}`);
      const result = await deploy({
        data: {
          workspaceId,
          sql,
          bundlePath,
          contentBase64: b64,
          bucket: "deployments",
          label: `auto-deploy-${finalSlug}`,
          maxRetries: 2,
          ensureInfra: true,
        },
      });
      setDeployResult(result);
      for (const s of result.steps) {
        log(`${s.ok ? "✓" : "✗"} ${s.label}${s.attempts.at(-1)?.detail ? ` — ${s.attempts.at(-1)!.detail}` : ""}`);
      }
      if (!result.ok) throw new Error("Deploy pipeline reported failure — check logs below");
      log(`✅ Live in ${(result.totalMs / 1000).toFixed(1)}s`);
      setPhase("live");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      log(`✗ ${msg}`);
      setPhase("error");
    }
  };

  const liveUrl = useMemo(() => {
    if (!slug) return null;
    // Wildcard nginx from Phase E serves <slug>.apps.timescard.cloud
    return `https://${slug}.apps.timescard.cloud`;
  }, [slug]);

  const canRun = phase === "source" || phase === "error" || phase === "live";

  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Rocket className="h-6 w-6 text-primary" />
            Auto-Deploy Studio
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            GitHub, Git URL অথবা ZIP দিয়ে project দিন — analyze → Pluto backend এ wire → live URL। এক ক্লিকে ৩৬০° ডিগ্রি সম্পূর্ণ।
          </p>
        </div>
        {phase === "live" && (
          <button onClick={resetAll} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
            <RefreshCw className="h-4 w-4" /> নতুন deploy
          </button>
        )}
      </header>

      {/* Stepper */}
      <div className="flex items-center gap-2 text-xs">
        {(["source","analyzing","planning","bundling","deploying","live"] as Phase[]).map((p, i) => {
          const done = ["source","analyzing","planning","bundling","deploying","live"].indexOf(phase) > i;
          const active = phase === p;
          return (
            <div key={p} className="flex items-center gap-2">
              <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${
                done ? "bg-emerald-500/20 text-emerald-500" :
                active ? "bg-primary text-primary-foreground" :
                "bg-muted text-muted-foreground"
              }`}>
                {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <span className={active ? "font-medium" : "text-muted-foreground"}>{p}</span>
              {i < 5 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
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
            <button
              key={k}
              onClick={() => setSource(k)}
              disabled={!canRun}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm border transition-colors ${
                source === k ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        {source === "github" && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              className="sm:col-span-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="owner/repo (e.g. lovable/pluto-demo)"
              value={ghRepo}
              onChange={(e) => setGhRepo(e.target.value)}
              disabled={!canRun}
            />
            <input
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="branch / tag / sha (optional)"
              value={ghRef}
              onChange={(e) => setGhRef(e.target.value)}
              disabled={!canRun}
            />
            <p className="sm:col-span-3 text-xs text-muted-foreground">
              Public repos সরাসরি কাজ করে। Private repos-এর জন্য workspace-এ GitHub connector link করুন — request গেটওয়ে দিয়ে যাবে।
            </p>
          </div>
        )}

        {source === "giturl" && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              className="sm:col-span-2 rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="https://github.com/owner/repo"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              disabled={!canRun}
            />
            <input
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="ref (optional)"
              value={gitRef}
              onChange={(e) => setGitRef(e.target.value)}
              disabled={!canRun}
            />
          </div>
        )}

        {source === "zip" && (
          <div>
            <input
              ref={fileInput}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={!canRun}
            />
            <button
              onClick={() => fileInput.current?.click()}
              disabled={!canRun}
              className="w-full rounded-md border-2 border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
            >
              <FileArchive className="mx-auto mb-2 h-6 w-6" />
              {file ? `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)` : "Click to select .zip (max 200 MB)"}
            </button>
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-border">
          <div className="text-xs text-muted-foreground">
            Workspace: <span className="font-mono">{workspace?.slug ?? "—"}</span>
          </div>
          <button
            onClick={run}
            disabled={!canRun || !workspaceId}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {phase !== "source" && phase !== "error" && phase !== "live" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {phase === "live" ? "আবার deploy" : phase === "error" ? "Retry" : "Analyze & Deploy"}
          </button>
        </div>
      </section>

      {/* Live URL card */}
      {phase === "live" && liveUrl && (
        <section className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-5 space-y-3">
          <div className="flex items-center gap-2 text-emerald-500">
            <CheckCircle2 className="h-5 w-5" />
            <span className="font-semibold">✅ Live — deploy সফল</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 min-w-0 rounded-md bg-background px-3 py-2 text-sm font-mono truncate border border-border">
              {liveUrl}
            </code>
            <button
              onClick={() => { navigator.clipboard.writeText(liveUrl); toast.success("Copied"); }}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent flex items-center gap-1.5"
            >
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
            <a
              href={liveUrl} target="_blank" rel="noreferrer"
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5"
            >
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
          </div>
        </section>
      )}

      {/* Error banner */}
      {phase === "error" && errorMsg && (
        <section className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive flex items-start gap-2">
          <XCircle className="h-5 w-5 shrink-0" />
          <div>
            <div className="font-semibold">Deploy failed</div>
            <div className="text-destructive/80 mt-0.5">{errorMsg}</div>
          </div>
        </section>
      )}

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
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md bg-background border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold mt-0.5">{value}</div>
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
