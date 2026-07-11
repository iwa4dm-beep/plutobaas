import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useRef, useMemo } from "react";
import JSZip from "jszip";
import { Upload, FileArchive, Sparkles, Database, Wand2, Download, Loader2, CheckCircle2, AlertTriangle, RefreshCw, ShieldCheck, FileText, PlugZap, PlayCircle, ScrollText, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { analyzeZip } from "@/lib/autoconnect/analyzer";
import { planIntegration } from "@/lib/autoconnect/ai-planner.functions";
import { buildBundle, downloadBlob } from "@/lib/autoconnect/bundler";
import { buildMigrationBundle } from "@/lib/autoconnect/migration-converter";
import { mysqlToPg } from "@/lib/autoconnect/mysql-to-pg";
import { analyzeSql, summarizeImpact } from "@/lib/autoconnect/sql-analyzer";
import { validateDbConnection } from "@/lib/autoconnect/db-wizard.functions";
import { buildStructureReport, groupFiles } from "@/lib/autoconnect/structure-report";
import { verifyZip, type VerifyResult } from "@/lib/autoconnect/zip-verify";
import { parseRollbackLog, type LogSummary } from "@/lib/autoconnect/rollback-log";
import { runE2E, type E2EReport } from "@/lib/autoconnect/e2e-runner";
import type { AnalyzeResult, DbConfig, IntegrationPlan, SqlStatement } from "@/lib/autoconnect/types";

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
  const [db, setDb] = useState<DbConfig>({ driver: "postgres", url: "" });
  const [ackDestructive, setAckDestructive] = useState(false);
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
      setZip(z); log("ZIP extracted in-memory ✓");
      setStep(2);
    } catch (e) { toast.error("ZIP পড়া যায়নি: " + (e as Error).message); }
    finally { setBusy(false); }
  };

  const runAnalyze = async () => {
    if (!file) return;
    setBusy(true); log("Analyzing project structure…");
    try {
      const r = await analyzeZip(file, log);
      setAnalyze(r);
      log(`✓ ${r.backend.tables.length} tables · ${r.backend.routes.length} routes · ${r.frontend.apiCallSites.length} API sites · ${r.stats.usedFiles}/${r.stats.totalFiles} used`);
      setStep(3);
    } catch (e) { toast.error("Analyze fail: " + (e as Error).message); }
    finally { setBusy(false); }
  };

  const runPlan = async () => {
    if (!analyze) return;
    setBusy(true); log("Calling AI planner…");
    try {
      const r = await planIntegration({ data: { analyze } });
      setPlan(r.plan); setPlanModel(r.model);
      log(`✓ Plan from ${r.model} — ${r.plan.tables.length} tables, ${r.plan.endpoints.length} endpoints`);
    } catch (e) { toast.error("Planner fail: " + (e as Error).message); log("✗ " + (e as Error).message); }
    finally { setBusy(false); }
  };

  const runValidateDb = async () => {
    if (!db.url) { toast.error("Connection URL দিন"); return; }
    setBusy(true); log(`Validating ${db.driver} URL…`);
    try {
      const r = await validateDbConnection({ data: { driver: db.driver, url: db.url } });
      setDb({ ...db, ...r.parsed, validated: r.ok, message: r.message });
      log((r.ok ? "✓ " : "✗ ") + r.message);
      if (!r.ok) toast.error(r.message);
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  const runBuild = async () => {
    if (!zip || !analyze || !plan) return;
    setBusy(true); log("Building bundle (SQL + rewrite + restore-pack + env-template)…");
    try {
      const a = await buildBundle(zip, analyze, plan, db.validated ? db : undefined);
      setArtifacts(a); log("✓ Bundle ready"); setStep(6);
    } catch (e) { toast.error("Build fail: " + (e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Auto-Connect Studio</h1>
          <p className="mt-2 text-muted-foreground">
            React + Vite + Laravel প্রজেক্টের ZIP আপলোড করুন। AI নিজেই স্ক্যান করে Pluto BaaS-এর সাথে সব কানেক্ট করবে —
            মাইগ্রেশন (dry-run + auto-rollback), env auto-map, MySQL/PostgreSQL wizard, structure report — সব অটো।
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
            {step === 4 && plan && (
              <MigrationsStep
                plan={plan}
                db={db}
                setDb={setDb}
                onValidateDb={runValidateDb}
                ack={ackDestructive}
                setAck={setAckDestructive}
                onNext={() => setStep(5)}
                busy={busy}
              />
            )}
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
                onClick={() => { setStep(1); setFile(null); setZip(null); setAnalyze(null); setPlan(null); setArtifacts(null); setLogs([]); setDb({ driver: "postgres", url: "" }); setAckDestructive(false); }}
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
    { n: 3, label: "AI Plan + Structure", icon: Sparkles },
    { n: 4, label: "DB Wizard + Dry-Run", icon: Database },
    { n: 5, label: "Wire APIs", icon: Wand2 },
    { n: 6, label: "Download", icon: Download },
  ] as const;
  return (
    <ol className="flex flex-wrap items-center gap-2">
      {steps.map((s) => {
        const active = s.n === current, done = s.n < current;
        const Icon = s.icon;
        return (
          <li key={s.n} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
            active ? "border-primary bg-primary/10 text-primary"
              : done ? "border-green-500/40 bg-green-500/5 text-green-600"
              : "border-border text-muted-foreground"
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
      <p className="mt-1 text-sm text-muted-foreground">Laravel migrations, models, routes, controllers এবং React/Vite API call sites স্ক্যান করবে।</p>
      {file && (
        <div className="mt-4 rounded-md bg-muted p-3 text-sm">
          <div className="font-medium">{file.name}</div>
          <div className="text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</div>
        </div>
      )}
      <button onClick={onRun} disabled={busy}
        className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileArchive className="h-4 w-4" />} স্ক্যান শুরু করুন
      </button>
    </div>
  );
}

function PlanStep({ analyze, plan, planModel, onPlan, onNext, busy }: {
  analyze: AnalyzeResult; plan: IntegrationPlan | null; planModel: string;
  onPlan: () => void; onNext: () => void; busy: boolean;
}) {
  const [showReport, setShowReport] = useState(false);
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">৩. Structure Report + AI Plan</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Files (used)" value={`${analyze.stats.usedFiles}/${analyze.stats.totalFiles}`} />
        <Stat label="Tables" value={analyze.backend.tables.length} />
        <Stat label="Routes" value={analyze.backend.routes.length} />
        <Stat label="API sites" value={analyze.frontend.apiCallSites.length} />
      </div>

      <button onClick={() => setShowReport((v) => !v)}
        className="mt-4 inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted">
        <FileText className="h-4 w-4" /> {showReport ? "Structure Report লুকান" : "বিস্তারিত Structure Report দেখুন"}
      </button>
      {showReport && <StructureReport analyze={analyze} />}

      {!plan ? (
        <button onClick={onPlan} disabled={busy}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} AI planner চালান
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
                  <span>→</span><span>{e.pluto}</span>
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
            DB Wizard + Migrations →
          </button>
        </div>
      )}
    </div>
  );
}

function StructureReport({ analyze }: { analyze: AnalyzeResult }) {
  const g = useMemo(() => groupFiles(analyze.files), [analyze.files]);
  const md = useMemo(() => buildStructureReport(analyze), [analyze]);
  const [tab, setTab] = useState<"frontend" | "backend" | "config">("backend");
  const list = g[tab];
  return (
    <div className="mt-3 rounded-md border border-border p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-1">
          {(["backend", "frontend", "config"] as const).map((k) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded px-2.5 py-1 text-xs ${tab === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}>
              {k} ({g[k].length})
            </button>
          ))}
        </div>
        <button
          onClick={() => downloadBlob(new Blob([md], { type: "text/markdown" }), "STRUCTURE_REPORT.md")}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <Download className="h-3 w-3" /> report .md
        </button>
      </div>
      <ul className="max-h-64 space-y-0.5 overflow-auto font-mono text-xs">
        {list.slice(0, 500).map((f) => (
          <li key={f.path} className={`flex items-center gap-2 rounded px-1.5 py-0.5 ${
            f.used ? "bg-green-500/10 text-green-800 dark:text-green-200" : "text-muted-foreground"
          }`}>
            <span className="w-4 shrink-0">{f.used ? "✅" : "▫️"}</span>
            <span className="truncate">{f.path}</span>
            {f.reason && <span className="ml-auto shrink-0 rounded bg-primary/10 px-1.5 text-[10px] text-primary">{f.reason}</span>}
          </li>
        ))}
        {list.length === 0 && <li className="text-muted-foreground">— empty —</li>}
      </ul>
    </div>
  );
}

function MigrationsStep({ plan, db, setDb, onValidateDb, ack, setAck, onNext, busy }: {
  plan: IntegrationPlan; db: DbConfig; setDb: (d: DbConfig) => void;
  onValidateDb: () => void; ack: boolean; setAck: (v: boolean) => void;
  onNext: () => void; busy: boolean;
}) {
  const tables = plan.tables.map((t) => ({ name: t.name, columns: t.columns, timestamps: true }));
  const rawSql = useMemo(() => buildMigrationBundle(tables), [tables]);
  const sql = db.driver === "mysql" ? mysqlToPg(rawSql) : rawSql;
  const stmts = useMemo(() => analyzeSql(sql), [sql]);
  const impact = useMemo(() => summarizeImpact(stmts), [stmts]);
  const canProceed = impact.destructive === 0 || ack;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">৪a. DB Wizard</h2>
        <p className="mt-1 text-sm text-muted-foreground">MySQL/PostgreSQL নির্বাচন ও connection string যাচাই — উপযুক্ত ড্রাইভার/কনফিগ auto-generate হবে।</p>
        <div className="mt-4 flex gap-3">
          {(["postgres", "mysql"] as const).map((d) => (
            <label key={d} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              db.driver === d ? "border-primary bg-primary/10" : "border-border"
            }`}>
              <input type="radio" name="driver" checked={db.driver === d}
                onChange={() => setDb({ ...db, driver: d, validated: false, message: undefined })} />
              {d === "postgres" ? "PostgreSQL" : "MySQL"}
            </label>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            placeholder={db.driver === "postgres" ? "postgres://user:pass@host:5432/db" : "mysql://user:pass@host:3306/db"}
            value={db.url}
            onChange={(e) => setDb({ ...db, url: e.target.value, validated: false })}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
          />
          <button onClick={onValidateDb} disabled={busy || !db.url}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Validate
          </button>
        </div>
        {db.message && (
          <div className={`mt-2 rounded-md border p-2 text-xs ${
            db.validated ? "border-green-500/40 bg-green-500/5 text-green-700 dark:text-green-300"
              : "border-yellow-500/40 bg-yellow-500/5 text-yellow-700 dark:text-yellow-300"
          }`}>{db.message}</div>
        )}
      </div>

      <div>
        <h2 className="text-lg font-semibold text-foreground">৪b. Dry-Run Preview</h2>
        <p className="mt-1 text-sm text-muted-foreground">apply-এর আগে diff + impact — destructive statement থাকলে ম্যানুয়াল acknowledgement লাগবে।</p>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="Total" value={impact.total} />
          <Stat label="New tables" value={impact.newTables} />
          <Stat label="RLS" value={impact.rlsEnabled} />
          <Stat label="Grants" value={impact.grants} />
          <Stat label="Destructive" value={impact.destructive} tone={impact.destructive > 0 ? "danger" : "ok"} />
        </div>

        <div className="mt-3 max-h-80 overflow-auto rounded-md border border-border">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left">Kind</th>
                <th className="px-2 py-1 text-left">Table</th>
                <th className="px-2 py-1 text-left">Statement</th>
              </tr>
            </thead>
            <tbody>
              {stmts.slice(0, 200).map((s, i) => (
                <tr key={i} className={
                  s.destructive ? "bg-red-500/10"
                    : s.kind === "create_table" ? "bg-green-500/5"
                    : s.kind === "alter" ? "bg-yellow-500/5"
                    : ""
                }>
                  <td className="px-2 py-1 align-top">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                      s.destructive ? "bg-red-500/20 text-red-700 dark:text-red-300"
                        : s.kind === "create_table" ? "bg-green-500/20 text-green-700 dark:text-green-300"
                        : "bg-muted text-muted-foreground"
                    }`}>{s.kind}</span>
                  </td>
                  <td className="px-2 py-1 align-top text-muted-foreground">{s.table ?? "—"}</td>
                  <td className="px-2 py-1 align-top"><pre className="whitespace-pre-wrap break-all">{s.sql.slice(0, 200)}</pre></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {impact.destructive > 0 && (
          <label className="mt-3 flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" />
            <span className="text-red-800 dark:text-red-200">
              <ShieldCheck className="inline h-4 w-4" /> <b>{impact.destructive}</b> destructive statement আছে — আমি বুঝেছি এবং apply-এ সম্মতি দিচ্ছি। ব্যর্থ হলে <code>apply.sh</code> auto-rollback করবে।
            </span>
          </label>
        )}
      </div>

      <button onClick={onNext} disabled={!canProceed}
        className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
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
      </p>
      <div className="mt-4 rounded-md bg-muted p-3 text-sm">
        <div>Rewrites planned: <b>{plan.frontendRewrites.length}</b></div>
        <div>Storage buckets: <b>{plan.storageBuckets.length}</b></div>
        <div>Auth bridge: <b>{plan.auth.source}</b> → <b>{plan.auth.target}</b></div>
      </div>
      <button onClick={onBuild} disabled={busy}
        className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Bundle তৈরি করুন
      </button>
    </div>
  );
}

function DownloadStep({ artifacts }: { artifacts: { frontend: Blob; migrations: Blob; report: Blob } }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">৬. Download</h2>
      <p className="mt-1 text-sm text-muted-foreground">Migration ZIP-এ apply.sh (auto-rollback), env template, install-secrets, db config, structure report — সব যুক্ত।</p>
      <div className="mt-5 grid gap-3">
        <FileCard name="frontend-connected.zip" size={artifacts.frontend.size} onClick={() => downloadBlob(artifacts.frontend, "frontend-connected.zip")} />
        <FileCard name="pluto-migrations.zip" size={artifacts.migrations.size} onClick={() => downloadBlob(artifacts.migrations, "pluto-migrations.zip")} />
        <FileCard name="INTEGRATION_REPORT.md" size={artifacts.report.size} onClick={() => downloadBlob(artifacts.report, "INTEGRATION_REPORT.md")} />
      </div>
      <div className="mt-6 rounded-md border border-green-500/40 bg-green-500/5 p-4 text-sm text-green-800 dark:text-green-200">
        <b>VPS-এ:</b> <code>unzip pluto-migrations.zip</code> → <code>bash install-secrets.sh</code> → <code>bash apply.sh</code>। ব্যর্থ হলে auto-rollback হবে।
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "ok" | "danger" }) {
  const c = tone === "danger" ? "border-red-500/40 bg-red-500/5" : "border-border bg-muted/40";
  return (
    <div className={`rounded-md border p-3 ${c}`}>
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
