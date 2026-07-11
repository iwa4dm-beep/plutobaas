import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useRef } from "react";
import JSZip from "jszip";
import { Upload, FileArchive, Sparkles, Database, Wand2, Download, Loader2, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { analyzeZip } from "@/lib/autoconnect/analyzer";
import { planIntegration } from "@/lib/autoconnect/ai-planner.functions";
import { buildBundle, downloadBlob } from "@/lib/autoconnect/bundler";
import type { AnalyzeResult, IntegrationPlan } from "@/lib/autoconnect/types";

export const Route = createFileRoute("/auto-connect")({
  head: () => ({
    meta: [
      { title: "Auto-Connect Studio — Pluto BaaS" },
      { name: "description", content: "React + Vite + Laravel ZIP আপলোড করুন, AI স্ক্যান করে Pluto BaaS-এর সাথে ফুল অটো-ওয়্যারিং করবে।" },
    ],
  }),
  component: AutoConnectPage,
});

type Step = 1 | 2 | 3 | 4 | 5 | 6;

function AutoConnectPage() {
  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<File | null>(null);
  const [zip, setZip] = useState<JSZip | null>(null);
  const [analyze, setAnalyze] = useState<AnalyzeResult | null>(null);
  const [plan, setPlan] = useState<IntegrationPlan | null>(null);
  const [planModel, setPlanModel] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [artifacts, setArtifacts] = useState<{ frontend: Blob; migrations: Blob; report: Blob } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const log = useCallback((m: string) => {
    setLogs((l) => [...l, `[${new Date().toLocaleTimeString()}] ${m}`]);
  }, []);

  const onFile = async (f: File) => {
    if (!f.name.endsWith(".zip")) { toast.error("শুধু .zip ফাইল দেওয়া যাবে"); return; }
    if (f.size > 200 * 1024 * 1024) { toast.error("ফাইল ২০০MB এর বেশি"); return; }
    setFile(f); setLogs([]);
    log(`Loaded ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
    setBusy(true);
    try {
      const z = await JSZip.loadAsync(f);
      setZip(z);
      log("ZIP extracted in-memory ✓");
      setStep(2);
    } catch (e) {
      toast.error("ZIP পড়া যায়নি: " + (e as Error).message);
    } finally { setBusy(false); }
  };

  const runAnalyze = async () => {
    if (!file) return;
    setBusy(true); log("Analyzing project structure…");
    try {
      const r = await analyzeZip(file, log);
      setAnalyze(r);
      log(`✓ ${r.backend.tables.length} tables, ${r.backend.routes.length} routes, ${r.frontend.apiCallSites.length} API call sites`);
      setStep(3);
    } catch (e) { toast.error("Analyze fail: " + (e as Error).message); }
    finally { setBusy(false); }
  };

  const runPlan = async () => {
    if (!analyze) return;
    setBusy(true); log("Calling AI planner (Lovable AI Gateway)…");
    try {
      const r = await planIntegration({ data: { analyze } });
      setPlan(r.plan); setPlanModel(r.model);
      log(`✓ Plan received from ${r.model} — ${r.plan.tables.length} tables, ${r.plan.endpoints.length} endpoints`);
    } catch (e) { toast.error("Planner fail: " + (e as Error).message); log("✗ " + (e as Error).message); }
    finally { setBusy(false); }
  };

  const runBuild = async () => {
    if (!zip || !analyze || !plan) return;
    setBusy(true); log("Building migrations SQL + rewriting frontend…");
    try {
      const a = await buildBundle(zip, analyze, plan);
      setArtifacts(a);
      log("✓ Bundle ready");
      setStep(6);
    } catch (e) { toast.error("Build fail: " + (e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Auto-Connect Studio</h1>
          <p className="mt-2 text-muted-foreground">
            React + Vite + Laravel প্রজেক্টের ZIP আপলোড করুন। AI নিজেই স্ক্যান করে Pluto BaaS-এর সাথে সব কানেক্ট করে দিবে —
            মাইগ্রেশন, RLS, REST/RPC endpoint, frontend rewrite, env — সব অটো।
          </p>
        </header>

        <Stepper current={step} />

        <div className="mt-8 grid gap-6 md:grid-cols-[1fr_360px]">
          <main className="rounded-lg border border-border bg-card p-6">
            {step === 1 && <UploadStep onFile={onFile} busy={busy} inputRef={inputRef} />}
            {step === 2 && <AnalyzeStep file={file} onRun={runAnalyze} busy={busy} />}
            {step === 3 && analyze && (
              <PlanStep analyze={analyze} plan={plan} planModel={planModel} onPlan={runPlan} onNext={() => setStep(4)} busy={busy} />
            )}
            {step === 4 && plan && <MigrationsStep plan={plan} onNext={() => setStep(5)} />}
            {step === 5 && plan && <WireStep plan={plan} onBuild={runBuild} busy={busy} />}
            {step === 6 && artifacts && <DownloadStep artifacts={artifacts} />}
          </main>

          <aside className="rounded-lg border border-border bg-card p-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Live Log</h3>
            <div className="h-[420px] overflow-auto rounded bg-muted p-3 font-mono text-xs text-muted-foreground">
              {logs.length === 0 ? <span className="opacity-60">…অপেক্ষা করছে…</span>
                : logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
            {step > 1 && (
              <button
                onClick={() => { setStep(1); setFile(null); setZip(null); setAnalyze(null); setPlan(null); setArtifacts(null); setLogs([]); }}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-muted"
              >
                <RefreshCw className="h-4 w-4" /> নতুন করে শুরু
              </button>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function Stepper({ current }: { current: Step }) {
  const steps = [
    { n: 1, label: "Upload", icon: Upload },
    { n: 2, label: "Analyze", icon: FileArchive },
    { n: 3, label: "AI Plan", icon: Sparkles },
    { n: 4, label: "Migrations", icon: Database },
    { n: 5, label: "Wire APIs", icon: Wand2 },
    { n: 6, label: "Download", icon: Download },
  ] as const;
  return (
    <ol className="flex flex-wrap items-center gap-2">
      {steps.map((s) => {
        const active = s.n === current;
        const done = s.n < current;
        const Icon = s.icon;
        return (
          <li key={s.n} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
            active ? "border-primary bg-primary/10 text-primary" :
            done ? "border-green-500/40 bg-green-500/5 text-green-600" :
            "border-border text-muted-foreground"
          }`}>
            {done ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
            <span>{s.n}. {s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function UploadStep({ onFile, busy, inputRef }: { onFile: (f: File) => void; busy: boolean; inputRef: React.RefObject<HTMLInputElement | null> }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">১. প্রজেক্ট ZIP আপলোড</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        React + Vite frontend এবং Laravel backend একই ZIP-এ থাকলেই চলবে। <code>node_modules</code>, <code>vendor</code>, <code>.git</code> auto-skip হবে।
      </p>
      <label
        className="mt-6 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border py-16 text-center transition hover:border-primary hover:bg-primary/5"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      >
        {busy ? <Loader2 className="h-10 w-10 animate-spin text-primary" /> : <Upload className="h-10 w-10 text-muted-foreground" />}
        <p className="mt-3 text-sm text-foreground">ZIP এখানে drag করুন অথবা</p>
        <button type="button" onClick={() => inputRef.current?.click()}
          className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          ফাইল সিলেক্ট করুন
        </button>
        <input ref={inputRef} type="file" accept=".zip" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
        <p className="mt-4 text-xs text-muted-foreground">সর্বোচ্চ ২০০MB</p>
      </label>
    </div>
  );
}

function AnalyzeStep({ file, onRun, busy }: { file: File | null; onRun: () => void; busy: boolean }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">২. AI Analyze</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        ZIP-এর ভেতর Laravel migrations, models, routes, controllers এবং React/Vite API call sites স্ক্যান করবে।
      </p>
      {file && (
        <div className="mt-4 rounded-md bg-muted p-3 text-sm">
          <div className="font-medium">{file.name}</div>
          <div className="text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</div>
        </div>
      )}
      <button onClick={onRun} disabled={busy}
        className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileArchive className="h-4 w-4" />}
        স্ক্যান শুরু করুন
      </button>
    </div>
  );
}

function PlanStep({ analyze, plan, planModel, onPlan, onNext, busy }: {
  analyze: AnalyzeResult; plan: IntegrationPlan | null; planModel: string;
  onPlan: () => void; onNext: () => void; busy: boolean;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">৩. Review Plan</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Tables" value={analyze.backend.tables.length} />
        <Stat label="Routes" value={analyze.backend.routes.length} />
        <Stat label="Models" value={analyze.backend.models.length} />
        <Stat label="API sites" value={analyze.frontend.apiCallSites.length} />
      </div>

      {!plan ? (
        <button onClick={onPlan} disabled={busy}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          AI planner চালান
        </button>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="text-xs text-muted-foreground">Model: <code>{planModel}</code></div>

          <Section title={`Tables (${plan.tables.length})`}>
            <ul className="max-h-48 space-y-1 overflow-auto text-sm">
              {plan.tables.map((t) => (
                <li key={t.name} className="flex justify-between border-b border-border py-1">
                  <span className="font-mono">{t.name}</span>
                  <span className="text-muted-foreground">{t.columns.length} cols · RLS:{t.rls}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title={`Endpoints (${plan.endpoints.length})`}>
            <ul className="max-h-48 space-y-1 overflow-auto text-xs font-mono">
              {plan.endpoints.slice(0, 30).map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="w-56 truncate text-muted-foreground">{e.laravel}</span>
                  <span>→</span>
                  <span>{e.pluto}</span>
                </li>
              ))}
            </ul>
          </Section>

          {plan.risks.length > 0 && (
            <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-yellow-700 dark:text-yellow-400">
                <AlertTriangle className="h-4 w-4" /> Risks
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-yellow-800 dark:text-yellow-200">
                {plan.risks.map((r, i) => <li key={i}><b>[{r.severity}]</b> {r.message}</li>)}
              </ul>
            </div>
          )}

          <button onClick={onNext}
            className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Migrations দেখুন →
          </button>
        </div>
      )}
    </div>
  );
}

function MigrationsStep({ plan, onNext }: { plan: IntegrationPlan; onNext: () => void }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">৪. Migrations</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        প্রতিটি টেবিলে auto-generate হবে: <code>CREATE TABLE</code>, <code>GRANT</code>, <code>RLS ENABLE</code>, owner policy।
      </p>
      <div className="mt-4 max-h-72 overflow-auto rounded bg-muted p-3 font-mono text-xs">
        {plan.tables.map((t) => (
          <div key={t.name} className="mb-3">
            <div className="text-primary">CREATE TABLE public.{t.name} (…{t.columns.length} cols)</div>
            <div className="text-muted-foreground">GRANT SELECT,INSERT,UPDATE,DELETE ON public.{t.name} TO authenticated;</div>
            <div className="text-muted-foreground">ENABLE RLS + owner policy ({t.rls})</div>
          </div>
        ))}
        {plan.tables.length === 0 && <span className="text-muted-foreground">— কোনো টেবিল প্ল্যান করা হয়নি —</span>}
      </div>
      <button onClick={onNext}
        className="mt-5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
        Wire APIs →
      </button>
    </div>
  );
}

function WireStep({ plan, onBuild, busy }: { plan: IntegrationPlan; onBuild: () => void; busy: boolean }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">৫. Wire APIs & Rewrite Frontend</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Laravel routes → Pluto REST/RPC map হবে। Frontend-এ axios baseURL, fetch paths, auth headers auto-rewrite হবে।
        Pluto client (<code>src/lib/pluto-client.ts</code>) inject হবে।
      </p>
      <div className="mt-4 rounded-md bg-muted p-3 text-sm">
        <div>Rewrites planned: <b>{plan.frontendRewrites.length}</b></div>
        <div>Storage buckets: <b>{plan.storageBuckets.length}</b></div>
        <div>Auth bridge: <b>{plan.auth.source}</b> → <b>{plan.auth.target}</b></div>
      </div>
      <button onClick={onBuild} disabled={busy}
        className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
        Bundle তৈরি করুন
      </button>
    </div>
  );
}

function DownloadStep({ artifacts }: { artifacts: { frontend: Blob; migrations: Blob; report: Blob } }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">৬. Download</h2>
      <p className="mt-1 text-sm text-muted-foreground">তিনটি ফাইল রেডি — ডাউনলোড করে VPS-এ apply করুন।</p>
      <div className="mt-5 grid gap-3">
        <FileCard name="frontend-connected.zip" size={artifacts.frontend.size} onClick={() => downloadBlob(artifacts.frontend, "frontend-connected.zip")} />
        <FileCard name="pluto-migrations.zip" size={artifacts.migrations.size} onClick={() => downloadBlob(artifacts.migrations, "pluto-migrations.zip")} />
        <FileCard name="INTEGRATION_REPORT.md" size={artifacts.report.size} onClick={() => downloadBlob(artifacts.report, "INTEGRATION_REPORT.md")} />
      </div>
      <div className="mt-6 rounded-md border border-green-500/40 bg-green-500/5 p-4 text-sm text-green-800 dark:text-green-200">
        <b>Next:</b> Migrations SQL apply করুন → <code>frontend-connected.zip</code> unzip করে <code>.env</code> ফিল করুন → <code>npm i @pluto/client && npm run dev</code>।
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 text-sm font-semibold text-foreground">{title}</div>
      {children}
    </div>
  );
}

function FileCard({ name, size, onClick }: { name: string; size: number; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="flex items-center justify-between rounded-md border border-border bg-card p-4 text-left transition hover:border-primary hover:bg-primary/5">
      <div>
        <div className="font-medium text-foreground">{name}</div>
        <div className="text-xs text-muted-foreground">{(size / 1024).toFixed(1)} KB</div>
      </div>
      <Download className="h-5 w-5 text-primary" />
    </button>
  );
}
