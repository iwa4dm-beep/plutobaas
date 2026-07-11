import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useRef, useMemo } from "react";
import JSZip from "jszip";
import { Upload, FileArchive, Sparkles, Database, Wand2, Download, Loader2, CheckCircle2, AlertTriangle, RefreshCw, ShieldCheck, FileText, PlugZap, PlayCircle, ScrollText, ShieldAlert, XCircle, Radar, StopCircle, HelpCircle } from "lucide-react";
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
import { buildAuditJson, buildAuditHtml, buildAuditBundle, type AuditInput, type CancellationRecord } from "@/lib/autoconnect/audit-report";
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

type Tab = "wizard" | "test" | "logs";

function AutoConnectPage() {
  const [tab, setTab] = useState<Tab>("wizard");
  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<File | null>(null);
  const [zip, setZip] = useState<JSZip | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [analyze, setAnalyze] = useState<AnalyzeResult | null>(null);
  const [plan, setPlan] = useState<IntegrationPlan | null>(null);
  const [planModel, setPlanModel] = useState<string>("");
  const [db, setDb] = useState<DbConfig>({ driver: "postgres", url: "" });
  const [ackDestructive, setAckDestructive] = useState(false);
  const [ackTyped, setAckTyped] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [artifacts, setArtifacts] = useState<{ frontend: Blob; migrations: Blob; report: Blob } | null>(null);
  const [retentionDays, setRetentionDays] = useState<number>(14);
  const [snapshotRoot, setSnapshotRoot] = useState<string>("/var/backups/pluto-autoconnect");
  const [lastRollback, setLastRollback] = useState<LogSummary | null>(null);
  const [rawLog, setRawLog] = useState<string>("");
  const [cancellation, setCancellation] = useState<CancellationRecord | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const log = useCallback((m: string) => {
    setLogs((l) => [...l, `[${new Date().toLocaleTimeString()}] ${m}`]);
  }, []);

  const onFile = async (f: File) => {
    if (!f.name.endsWith(".zip")) { toast.error("শুধু .zip ফাইল দেওয়া যাবে"); return; }
    if (f.size > 200 * 1024 * 1024) { toast.error("ফাইল ২০০MB এর বেশি"); return; }
    setFile(f); setLogs([]); setVerify(null);
    log(`Loaded ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
    setBusy(true);
    try {
      const z = await JSZip.loadAsync(f);
      setZip(z); log("ZIP extracted in-memory ✓");
      log("Running integrity verification…");
      const v = await verifyZip(z);
      setVerify(v);
      log(v.ok ? `✓ Integrity: ${v.message}` : `✘ Integrity: ${v.message}`);
      if (v.hasManifest && !v.ok) { toast.error("ZIP integrity check failed"); return; }
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
      const a = await buildBundle(zip, analyze, plan, db.validated ? db : undefined, { retentionDays, snapshotRoot });
      setArtifacts(a); log("✓ Bundle ready"); setStep(6);
    } catch (e) { toast.error("Build fail: " + (e as Error).message); }
    finally { setBusy(false); }
  };

  const auditInput = useMemo<AuditInput>(() => {
    let impact = null;
    if (plan) {
      const tables = plan.tables.map((t) => ({ name: t.name, columns: t.columns, timestamps: true }));
      let sql = buildMigrationBundle(tables);
      if (db.driver === "mysql") sql = mysqlToPg(sql);
      impact = summarizeImpact(analyzeSql(sql));
    }
    return {
      project: { file: file?.name, sizeBytes: file?.size },
      db, plan, impact,
      ack: { checkbox: ackDestructive, typed: ackTyped, required: (impact?.destructive ?? 0) > 0 },
      verification: verify,
      rollback: lastRollback,
      retentionDays, snapshotRoot, cancellation,
      rawLogJsonl: rawLog || null,
    };
  }, [plan, db, file, ackDestructive, ackTyped, verify, lastRollback, retentionDays, snapshotRoot, cancellation, rawLog]);

  const buildAudit = useCallback(() => {
    const report = buildAuditJson(auditInput);
    const json = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const html = new Blob([buildAuditHtml(report)], { type: "text/html" });
    return { json, html };
  }, [auditInput]);

  const downloadAuditZip = useCallback(async () => {
    const blob = await buildAuditBundle(auditInput);
    const jobId = lastRollback?.jobId || cancellation?.jobId || "audit";
    downloadBlob(blob, `audit-${jobId}.zip`);
  }, [auditInput, lastRollback, cancellation]);


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

        <div className="mb-4 flex gap-2">
          {([
            ["wizard", "Wizard", Wand2],
            ["test", "Test Mode", PlayCircle],
            ["logs", "Rollback Logs", ScrollText],
          ] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm ${
                tab === k ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"
              }`}>
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        {tab === "wizard" && <Stepper current={step} />}

        <div className="mt-6 grid gap-6 md:grid-cols-[1fr_360px]">
          <main className="rounded-lg border border-border bg-card p-6">
            {tab === "wizard" && <>
              {step === 1 && <UploadStep onFile={onFile} busy={busy} inputRef={inputRef} verify={verify} />}
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
                  ackTyped={ackTyped}
                  setAckTyped={setAckTyped}
                  onNext={() => setStep(5)}
                  busy={busy}
                  verify={verify}
                />
              )}
              {step === 5 && plan && <WireStep plan={plan} retentionDays={retentionDays} setRetentionDays={setRetentionDays} snapshotRoot={snapshotRoot} setSnapshotRoot={setSnapshotRoot} onBuild={runBuild} busy={busy} />}
              {step === 6 && artifacts && <DownloadStep artifacts={artifacts} buildAudit={buildAudit} downloadAuditZip={downloadAuditZip} rawLog={rawLog} />}
            </>}
            {tab === "test" && <TestModePanel plan={plan} db={db} auditInput={auditInput} onSimulated={(r) => { setRawLog(r.jsonl); setLastRollback(parseRollbackLog(r.jsonl)); }} />}
            {tab === "logs" && <RollbackLogPanel onLoaded={setLastRollback} rawLog={rawLog} setRawLog={setRawLog} cancellation={cancellation} setCancellation={setCancellation} log={log} />}
          </main>


          <aside className="rounded-lg border border-border bg-card p-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Live Log</h3>
            <div className="h-[420px] overflow-auto rounded bg-muted p-3 font-mono text-xs text-muted-foreground">
              {logs.length === 0 ? <span className="opacity-60">…অপেক্ষা করছে…</span>
                : logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
            {step > 1 && (
              <button
                onClick={() => { setStep(1); setFile(null); setZip(null); setVerify(null); setAnalyze(null); setPlan(null); setArtifacts(null); setLogs([]); setDb({ driver: "postgres", url: "" }); setAckDestructive(false); setAckTyped(""); }}
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

function UploadStep({ onFile, busy, inputRef, verify }: { onFile: (f: File) => void; busy: boolean; inputRef: React.RefObject<HTMLInputElement | null>; verify: VerifyResult | null }) {
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
      {verify && <VerifyPanel verify={verify} />}
    </div>
  );
}

function VerifyPanel({ verify }: { verify: VerifyResult }) {
  const bad = verify.entries.filter((e) => !e.ok);
  return (
    <div className={`mt-4 rounded-md border p-3 text-sm ${
      !verify.hasManifest ? "border-border bg-muted/40"
        : verify.ok ? "border-green-500/40 bg-green-500/5"
        : "border-red-500/40 bg-red-500/5"
    }`}>
      <div className="flex items-center gap-2 font-medium">
        {!verify.hasManifest ? <FileText className="h-4 w-4" /> :
          verify.ok ? <CheckCircle2 className="h-4 w-4 text-green-600" /> :
          <ShieldAlert className="h-4 w-4 text-red-600" />}
        Integrity check: {verify.message}
      </div>
      {verify.hasManifest && (
        <div className="mt-2 text-xs text-muted-foreground">
          Manifest generated: {verify.manifest?.generatedAt ?? "—"} · files: {verify.entries.length}
        </div>
      )}
      {bad.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-0.5 overflow-auto font-mono text-xs">
          {bad.slice(0, 30).map((e) => (
            <li key={e.path} className="text-red-700 dark:text-red-300">
              ✘ {e.path} {e.actual ? "hash mismatch" : "missing"}
            </li>
          ))}
        </ul>
      )}
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

function MigrationsStep({ plan, db, setDb, onValidateDb, ack, setAck, ackTyped, setAckTyped, onNext, busy, verify }: {
  plan: IntegrationPlan; db: DbConfig; setDb: (d: DbConfig) => void;
  onValidateDb: () => void; ack: boolean; setAck: (v: boolean) => void;
  ackTyped: string; setAckTyped: (v: string) => void;
  onNext: () => void; busy: boolean; verify: VerifyResult | null;
}) {
  const tables = plan.tables.map((t) => ({ name: t.name, columns: t.columns, timestamps: true }));
  const rawSql = useMemo(() => buildMigrationBundle(tables), [tables]);
  const sql = db.driver === "mysql" ? mysqlToPg(rawSql) : rawSql;
  const stmts = useMemo(() => analyzeSql(sql), [sql]);
  const impact = useMemo(() => summarizeImpact(stmts), [stmts]);
  const needsTyped = impact.destructive > 0;
  const canProceed = !needsTyped || (ack && ackTyped.trim().toUpperCase() === "APPLY");

  return (
    <div className="space-y-6">
      <PreApplyVerification verify={verify} />
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

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Total stmts" value={impact.total} />
          <Stat label="New tables" value={impact.newTables} />
          <Stat label="RLS enabled" value={impact.rlsEnabled} />
          <Stat label="Policies" value={impact.policies} />
          <Stat label="Grants" value={impact.grants} />
          <Stat label="Cols +/−" value={`${impact.columnsAdded}/${impact.columnsDropped}`} tone={impact.columnsDropped > 0 ? "danger" : undefined} />
          <Stat label="Indexes/FKs" value={`${impact.indexes}/${impact.fkAdded}`} />
          <Stat label="Destructive" value={impact.destructive} tone={impact.destructive > 0 ? "danger" : "ok"} />
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Tables touched ({impact.affectedTables.length}): <code>{impact.affectedTables.slice(0, 12).join(", ") || "—"}</code>
          {impact.affectedTables.length > 12 && ` +${impact.affectedTables.length - 12}`}
          {" · "}Roles: <code>{impact.rolesTouched.join(", ") || "—"}</code>
          {" · "}Row-impact estimate: <b>{impact.rowsEstimate}</b>
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
          <div className="mt-3 space-y-2 rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm">
            <div className="font-medium text-red-800 dark:text-red-200">
              <ShieldAlert className="mr-1 inline h-4 w-4" />
              {impact.destructive} destructive statement — data loss risk
            </div>
            <ul className="max-h-32 overflow-auto pl-5 text-xs font-mono text-red-700 dark:text-red-300">
              {impact.destructiveStatements.slice(0, 6).map((d, i) => (
                <li key={i} className="list-disc">
                  #{d.index} {d.kind} {d.table ? `on ${d.table}` : ""} — <span className="opacity-80">{d.sample}</span>
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" />
              <span className="text-red-800 dark:text-red-200">
                <ShieldCheck className="inline h-4 w-4" /> আমি impact বুঝেছি ও apply-এ সম্মতি দিচ্ছি (auto-rollback থাকবে)।
              </span>
            </label>
            <div className="text-xs text-red-800 dark:text-red-200">
              নিশ্চিতকরণ হিসেবে টাইপ করুন <code className="font-mono">APPLY</code>:
              <input
                type="text"
                value={ackTyped}
                onChange={(e) => setAckTyped(e.target.value)}
                placeholder="APPLY"
                className="ml-2 rounded-md border border-red-500/40 bg-background px-2 py-0.5 font-mono text-xs"
              />
            </div>
          </div>
        )}
      </div>


      <button onClick={onNext} disabled={!canProceed}
        className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        Wire APIs →
      </button>
    </div>
  );
}

function WireStep({ plan, retentionDays, setRetentionDays, snapshotRoot, setSnapshotRoot, onBuild, busy }: {
  plan: IntegrationPlan; retentionDays: number; setRetentionDays: (n: number) => void;
  snapshotRoot: string; setSnapshotRoot: (s: string) => void;
  onBuild: () => void; busy: boolean;
}) {
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
      <div className="mt-4 space-y-3 rounded-md border border-border p-3">
        <div className="text-sm font-semibold text-foreground">Snapshot storage</div>
        <label className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-3">
          <span className="w-40 shrink-0 text-muted-foreground">Storage path (SNAP_ROOT):</span>
          <input
            type="text" value={snapshotRoot}
            onChange={(e) => setSnapshotRoot(e.target.value || "/var/backups/pluto-autoconnect")}
            placeholder="/var/backups/pluto-autoconnect"
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
          />
        </label>
        <div className="text-xs text-muted-foreground">
          DB dump, Docker volume tarballs, config tarballs — সব এই একই path-এ store হবে,
          এবং retention cleanup-ও এই path থেকে চালাবে। Logs default: <code>&lt;SNAP_ROOT&gt;/logs</code>।
        </div>
        <label className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">Retention (days):</span>
          <input
            type="number" min={1} max={365} value={retentionDays}
            onChange={(e) => setRetentionDays(Math.max(1, Math.min(365, Number(e.target.value) || 14)))}
            className="w-24 rounded-md border border-border bg-background px-2 py-1 font-mono text-sm"
          />
          <span className="text-xs text-muted-foreground">apply.sh সফল হওয়ার পর এর চেয়ে পুরনো snapshot ও log auto-delete।</span>
        </label>
      </div>
      <button onClick={onBuild} disabled={busy}
        className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Bundle তৈরি করুন
      </button>
    </div>
  );
}

function DownloadStep({ artifacts, buildAudit, downloadAuditZip, rawLog }: {
  artifacts: { frontend: Blob; migrations: Blob; report: Blob };
  buildAudit: () => { json: Blob; html: Blob };
  downloadAuditZip: () => Promise<void>;
  rawLog: string;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">৬. Download</h2>
      <p className="mt-1 text-sm text-muted-foreground">Migration ZIP-এ apply.sh (verified + auto-rollback + retention), rollback.sh, cancel.sh, serve-progress.sh, env template — সব যুক্ত।</p>
      <div className="mt-5 grid gap-3">
        <FileCard name="frontend-connected.zip" size={artifacts.frontend.size} onClick={() => downloadBlob(artifacts.frontend, "frontend-connected.zip")} />
        <FileCard name="pluto-migrations.zip" size={artifacts.migrations.size} onClick={() => downloadBlob(artifacts.migrations, "pluto-migrations.zip")} />
        <FileCard name="INTEGRATION_REPORT.md" size={artifacts.report.size} onClick={() => downloadBlob(artifacts.report, "INTEGRATION_REPORT.md")} />
        <div className="rounded-md border border-primary/40 bg-primary/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary">
            <FileText className="h-4 w-4" /> Single audit report (impact + ack + verification + rollback + cancellation)
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => { const { json } = buildAudit(); downloadBlob(json, "audit-report.json"); }}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90">
              Download JSON
            </button>
            <button onClick={() => { const { html } = buildAudit(); downloadBlob(html, "audit-report.html"); }}
              className="rounded-md border border-primary/40 px-3 py-1.5 text-sm text-primary hover:bg-primary/10">
              Download HTML
            </button>
            <button
              disabled={!rawLog}
              onClick={() => downloadBlob(new Blob([rawLog], { type: "application/x-ndjson" }), "progress-log.jsonl")}
              className="inline-flex items-center gap-1 rounded-md border border-primary/40 px-3 py-1.5 text-sm text-primary hover:bg-primary/10 disabled:opacity-40"
              title={rawLog ? "Download raw JSONL progress + rollback log" : "Load a JSONL log in the Rollback Logs tab first"}
            >
              <Download className="h-3.5 w-3.5" /> Raw JSONL log {rawLog ? `(${(rawLog.length / 1024).toFixed(1)} KB)` : "(empty)"}
            </button>
            <button onClick={downloadAuditZip}
              className="inline-flex items-center gap-1 rounded-md bg-primary/90 px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary"
              title="Single ZIP: audit HTML/JSON + raw JSONL + verification-mismatch CSV">
              <FileArchive className="h-3.5 w-3.5" /> Download audit bundle (.zip)
            </button>
          </div>
        </div>
      </div>
      <div className="mt-6 rounded-md border border-green-500/40 bg-green-500/5 p-4 text-sm text-green-800 dark:text-green-200">
        <b>VPS-এ:</b> <code>unzip pluto-migrations.zip</code> → <code>bash install-secrets.sh</code> → <code>bash apply.sh</code>।
        Real-time progress: <code>bash serve-progress.sh 8787</code> → "Rollback Logs" tab-এ <b>Auto-detect</b> চাপুন
        (manual: <code>http://127.0.0.1:8787/stream</code>)।
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

// ---------------------------------------------------------------------------
// Test Mode — placeholder DB dry-run / apply / induced-fail + rollback loop
// ---------------------------------------------------------------------------
function TestModePanel({ plan, db, onSimulated, auditInput }: {
  plan: IntegrationPlan | null; db: DbConfig;
  onSimulated?: (r: E2EReport) => void;
  auditInput?: AuditInput;
}) {
  const [failAt, setFailAt] = useState(2);
  const [cancelAt, setCancelAt] = useState(1);
  const [report, setReport] = useState<E2EReport | null>(null);

  const stmts = useMemo<SqlStatement[]>(() => {
    if (!plan) return [];
    const tables = plan.tables.map((t) => ({ name: t.name, columns: t.columns, timestamps: true }));
    let sql = buildMigrationBundle(tables);
    if (db.driver === "mysql") sql = mysqlToPg(sql);
    return analyzeSql(sql);
  }, [plan, db.driver]);

  const run = (mode: E2EReport["mode"]) => {
    const r = runE2E(stmts, { mode, failAt, cancelAt });
    setReport(r);
    onSimulated?.(r);
  };

  const downloadSimulatedAudit = async () => {
    if (!report || !auditInput) return;
    const merged: AuditInput = {
      ...auditInput,
      rollback: parseRollbackLog(report.jsonl),
      rawLogJsonl: report.jsonl,
      cancellation: report.cancelled ? {
        at: new Date().toISOString(), via: "ui",
        jobId: `sim-${report.mode}`,
        phase: report.mode === "cancel-snapshot" ? "snapshot" : report.mode === "cancel-sql" ? "sql" : "unknown",
        exitCode: report.exitCode,
        note: `E2E ${report.mode} — passed=${report.passed}, rolledBack=${report.rolledBack}, exit=${report.exitCode}`,
      } : auditInput.cancellation,
    };
    const blob = await buildAuditBundle(merged);
    downloadBlob(blob, `audit-e2e-${report.mode}.zip`);
  };

  if (!plan) {
    return (
      <div className="text-sm text-muted-foreground">
        <PlayCircle className="mb-2 h-6 w-6" />
        আগে Wizard-এ ZIP আপলোড → Analyze → AI Plan চালান, তারপর এখানে ফিরে আসুন।
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">End-to-End Test Mode</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Placeholder in-browser simulator — কোনো real DB ছুঁবে না। Dry-run, apply, induced-fail,
          এবং <b>snapshot/SQL phase cancel → rollback + exit code 4</b> flow বারবার চালান।
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => run("dry-run")}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">Dry-Run</button>
        <button onClick={() => run("apply")}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90">Simulated Apply</button>
        <div className="flex items-center gap-1 text-sm">
          <span className="text-muted-foreground">Induced fail at #</span>
          <input type="number" value={failAt} min={0} max={Math.max(0, stmts.length - 1)}
            onChange={(e) => setFailAt(Number(e.target.value))}
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          <button onClick={() => run("induced-fail")}
            className="rounded-md bg-red-500 px-3 py-1.5 text-sm text-white hover:bg-red-600">Force Fail + Rollback</button>
        </div>
        <div className="ml-auto text-xs text-muted-foreground">total statements: {stmts.length}</div>
      </div>

      <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-3">
        <div className="mb-2 text-sm font-semibold text-yellow-800 dark:text-yellow-200">
          <StopCircle className="mr-1 inline h-4 w-4" /> Cancel-during-phase test
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Cancel at step #</span>
          <input type="number" value={cancelAt} min={0} max={Math.max(0, stmts.length - 1)}
            onChange={(e) => setCancelAt(Number(e.target.value))}
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          <button onClick={() => run("cancel-snapshot")}
            className="rounded-md bg-yellow-600 px-3 py-1.5 text-sm text-white hover:bg-yellow-700">
            Cancel during snapshot
          </button>
          <button onClick={() => run("cancel-sql")}
            className="rounded-md bg-yellow-600 px-3 py-1.5 text-sm text-white hover:bg-yellow-700">
            Cancel during SQL
          </button>
        </div>
        <div className="mt-1 text-xs text-yellow-800/80 dark:text-yellow-200/80">
          Verifies rollback runs and exit code <b>4</b> is journaled → audit report captures it.
        </div>
      </div>

      {report && (
        <div className={`rounded-md border p-3 text-sm ${
          report.passed ? "border-green-500/40 bg-green-500/5" : "border-red-500/40 bg-red-500/5"
        }`}>
          <div className="flex items-center justify-between">
            <div className="font-medium">
              {report.passed ? "✓ PASS" : "✘ FAIL"} · mode: <code>{report.mode}</code> ·
              {" "}{report.durationMs}ms · rolledBack: <b>{String(report.rolledBack)}</b> ·
              cancelled: <b>{String(report.cancelled)}</b> · exit: <b>{report.exitCode}</b> ·
              tables: {report.finalTables.length}
            </div>
            <button onClick={downloadSimulatedAudit} disabled={!auditInput}
              className="inline-flex items-center gap-1 rounded-md bg-primary/90 px-2.5 py-1 text-xs text-primary-foreground hover:bg-primary disabled:opacity-40">
              <FileArchive className="h-3 w-3" /> audit .zip
            </button>
          </div>
          {report.cancelled && report.exitCode === 4 && (
            <div className="mt-1 text-xs text-yellow-800 dark:text-yellow-200">
              ✓ cancel recorded · rollback ran · exit code <b>4</b> journaled in JSONL
            </div>
          )}
          <ul className="mt-2 max-h-64 space-y-0.5 overflow-auto font-mono text-xs">
            {report.steps.map((s) => (
              <li key={s.index} className={
                s.status === "failed" ? "text-red-700 dark:text-red-300"
                  : s.status === "cancelled" ? "text-yellow-700 dark:text-yellow-300"
                  : s.status === "skipped" ? "text-muted-foreground"
                  : "text-green-700 dark:text-green-300"
              }>
                #{s.index} [{s.status}] {s.sql.slice(0, 120)}
                {s.message && ` — ${s.message}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rollback Log Viewer — parse JSONL logs from apply.sh
// ---------------------------------------------------------------------------
function RollbackLogPanel({ onLoaded, rawLog, setRawLog, cancellation, setCancellation, log }: {
  onLoaded: (s: LogSummary | null) => void;
  rawLog: string; setRawLog: (s: string) => void;
  cancellation: CancellationRecord | null;
  setCancellation: (c: CancellationRecord | null) => void;
  log: (m: string) => void;
}) {
  const [summary, setSummary] = useState<LogSummary | null>(null);
  const [streamUrl, setStreamUrl] = useState<string>("http://127.0.0.1:8787/stream");
  const [streaming, setStreaming] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback((text: string) => {
    setRawLog(text);
    const s = parseRollbackLog(text);
    setSummary(s);
    onLoaded(s);
  }, [onLoaded, setRawLog]);

  const stopStream = useCallback(() => {
    esRef.current?.close(); esRef.current = null; setStreaming(false);
  }, []);

  const connectTo = useCallback((url: string) => {
    stopStream();
    try {
      const es = new EventSource(url);
      esRef.current = es;
      setStreaming(true);
      let buf = "";
      es.onmessage = (ev) => {
        buf += ev.data + "\n";
        setRawLog(buf);
        const s = parseRollbackLog(buf);
        setSummary(s); onLoaded(s);
      };
      es.onerror = () => { toast.error("SSE সংযোগ বিচ্ছিন্ন"); stopStream(); };
    } catch (e) { toast.error("Stream শুরু করা যায়নি: " + (e as Error).message); }
  }, [stopStream, onLoaded, setRawLog]);

  const startStream = useCallback(() => {
    if (!streamUrl) { toast.error("SSE URL দিন"); return; }
    connectTo(streamUrl);
  }, [streamUrl, connectTo]);

  // Auto-discover: probe common host:port combinations that serve-progress.sh
  // typically listens on. Uses exponential backoff so the /auto-connect page
  // still succeeds if the stream server starts a few seconds later than the
  // click (e.g. bash serve-progress.sh & racing the browser).
  const autoDiscover = useCallback(async () => {
    setDiscovering(true); log("Auto-discovering SSE endpoints (with retry)…");
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const candidates = [
      "http://127.0.0.1:8787",
      "http://localhost:8787",
      "http://127.0.0.1:8788",
      "http://localhost:9787",
      origin ? `${origin}/api/public/autoconnect` : "",
    ].filter(Boolean);
    const delays = [0, 500, 1000, 2000, 4000, 8000]; // ~15s total window
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
      log(`↻ attempt ${attempt + 1}/${delays.length}…`);
      for (const base of candidates) {
        try {
          const r = await Promise.race([
            fetch(`${base}/jobs`, { method: "GET" }),
            new Promise<Response>((_, rej) => setTimeout(() => rej(new Error("timeout")), 1200)),
          ]);
          if (!r.ok) continue;
          const j = await r.json().catch(() => null) as { jobs?: string[]; current?: string } | null;
          const job = j?.current || j?.jobs?.[0];
          const url = job ? `${base}/stream?job=${encodeURIComponent(job)}` : `${base}/stream`;
          setStreamUrl(url);
          log(`✓ Found progress server at ${base}${job ? ` (job=${job})` : ""} on attempt ${attempt + 1}`);
          connectTo(url);
          setDiscovering(false);
          toast.success(`Connected to ${base}`);
          return;
        } catch { /* try next */ }
      }
    }
    setDiscovering(false);
    log("✗ Auto-detect gave up after " + delays.length + " attempts");
    toast.error("Auto-detect failed — SSH tunnel / serve-progress.sh চালু আছে কিনা দেখুন");
  }, [connectTo, log]);

  // Download raw JSONL from stream server (or fall back to whatever's loaded).
  const downloadRawLog = useCallback(async () => {
    // Try to pull fresh from server if a stream URL is set
    try {
      const base = streamUrl.replace(/\/stream.*$/, "");
      const job = summary?.jobId && summary.jobId !== "unknown" ? summary.jobId : "";
      const url = `${base}/log${job ? `?job=${encodeURIComponent(job)}` : ""}`;
      const r = await Promise.race([
        fetch(url),
        new Promise<Response>((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500)),
      ]);
      if (r.ok) {
        const blob = await r.blob();
        downloadBlob(blob, `${job || "progress"}.jsonl`);
        return;
      }
    } catch { /* fall back */ }
    if (!rawLog) { toast.error("কোনো log নেই — আগে stream/upload করুন"); return; }
    downloadBlob(new Blob([rawLog], { type: "application/x-ndjson" }), `${summary?.jobId ?? "progress"}.jsonl`);
  }, [streamUrl, summary, rawLog]);

  // Cancel the running job — POST to the progress server's /cancel endpoint.
  // Refuses (locally and server-side) if the job has already finished, and
  // records a "refused" cancellation in the audit so operators see WHY.
  const cancelJob = useCallback(async () => {
    const job = summary?.jobId;
    if (!job || job === "unknown") { toast.error("জব চলছে না — cancel করার কিছু নেই"); return; }
    if (summary?.finished) {
      const at = new Date().toISOString();
      setCancellation({ at, jobId: job, via: "ui", refusedBecauseFinished: true,
        note: `Cancel refused — job already ${summary.ok ? "succeeded" : summary.rolledBack ? "rolled back" : summary.cancelled ? "cancelled" : "failed"} (exit ${summary.exitCode ?? "n/a"})` });
      log(`⚠ cancel refused for ${job} — job already terminated (exit ${summary.exitCode ?? "n/a"})`);
      toast.error("Cancel refused — job already finished");
      return;
    }
    if (!window.confirm(`Cancel job ${job}?\n\napply.sh will roll back at the next checkpoint. Continue?`)) return;
    setCancelling(true);
    try {
      const base = streamUrl.replace(/\/stream.*$/, "");
      const r = await fetch(`${base}/cancel?job=${encodeURIComponent(job)}`, { method: "POST" });
      const at = new Date().toISOString();
      if (r.status === 409) {
        const body = await r.json().catch(() => ({}));
        setCancellation({ at, jobId: job, via: "ui", refusedBecauseFinished: true,
          note: `Server refused: ${body?.reason ?? "already finished"}` });
        log(`⚠ server refused cancel for ${job}: ${body?.reason ?? "already finished"}`);
        toast.error("Server refused cancel — job already finished");
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const phase = summary?.entries.some((e) => e.step === "apply_sql") ? "sql" : "snapshot";
      setCancellation({ at, jobId: job, via: "ui", phase, exitCode: 4,
        note: `Cancelled via UI against ${base}` });
      log(`✔ cancel signal sent for ${job} — apply.sh will rollback at next checkpoint`);
      toast.success("Cancel signal sent — apply.sh will roll back safely");
    } catch (e) {
      const at = new Date().toISOString();
      setCancellation({ at, jobId: job, via: "ui",
        note: `Cancel attempted but server unreachable: ${(e as Error).message}` });
      toast.error("Cancel failed: " + (e as Error).message + " — manual: bash cancel.sh " + job);
    } finally { setCancelling(false); }
  }, [summary, streamUrl, log, setCancellation]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Rollback Log Viewer</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          VPS-এর JSONL log আপলোড করুন, অথবা <code>serve-progress.sh</code> থেকে real-time stream করুন।
          <b> Auto-detect</b> চাপলে সাধারণ endpoint scan করবে।
        </p>
      </div>

      <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold text-primary">Live Stream (SSE)</div>
          <button onClick={autoDiscover} disabled={discovering || streaming}
            className="inline-flex items-center gap-1 rounded-md bg-primary/20 px-2.5 py-1 text-xs text-primary hover:bg-primary/30 disabled:opacity-50">
            {discovering ? <Loader2 className="h-3 w-3 animate-spin" /> : <Radar className="h-3 w-3" />}
            Auto-detect
          </button>
        </div>
        <div className="flex gap-2">
          <input
            type="url" placeholder="http://127.0.0.1:8787/stream"
            value={streamUrl} onChange={(e) => setStreamUrl(e.target.value)}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
          />
          {!streaming ? (
            <button onClick={startStream}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90">
              Connect
            </button>
          ) : (
            <button onClick={stopStream}
              className="rounded-md bg-red-500 px-3 py-1.5 text-sm text-white hover:bg-red-600">
              Disconnect
            </button>
          )}
          <button onClick={cancelJob} disabled={cancelling || !summary?.jobId || summary.jobId === "unknown"}
            className="inline-flex items-center gap-1 rounded-md border border-red-500/60 bg-red-500/10 px-3 py-1.5 text-sm text-red-700 hover:bg-red-500/20 disabled:opacity-40 dark:text-red-300"
            title="Cooperatively cancel the running apply/rollback job">
            {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <StopCircle className="h-3.5 w-3.5" />}
            Cancel job
          </button>
        </div>
        {streaming && (
          <div className="mt-2 flex items-center gap-2 text-xs text-primary">
            <Loader2 className="h-3 w-3 animate-spin" /> live — {summary?.entries.length ?? 0} events · job: <code>{summary?.jobId ?? "?"}</code>
          </div>
        )}
        {cancellation && (
          <div className={`mt-2 rounded-md border p-2 text-xs ${
            cancellation.refusedBecauseFinished
              ? "border-yellow-500/40 bg-yellow-500/5 text-yellow-800 dark:text-yellow-200"
              : "border-red-500/40 bg-red-500/5 text-red-800 dark:text-red-200"
          }`}>
            <XCircle className="mr-1 inline h-3.5 w-3.5" />
            {cancellation.refusedBecauseFinished ? "Cancellation REFUSED" : "Cancellation recorded"} @ <code>{cancellation.at}</code>
            · job <code>{cancellation.jobId}</code>
            {cancellation.phase && <> · phase <b>{cancellation.phase}</b></>}
            {cancellation.exitCode != null && <> · exit <b>{cancellation.exitCode}</b></>}
            {cancellation.note && ` — ${cancellation.note}`}
            <button onClick={() => setCancellation(null)}
              className="ml-2 underline hover:opacity-70">clear</button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => fileRef.current?.click()}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
          .jsonl ফাইল লোড করুন
        </button>
        <input ref={fileRef} type="file" accept=".jsonl,.log,.txt,application/json" className="hidden"
          onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; load(await f.text()); }} />
        <button onClick={downloadRawLog} disabled={!rawLog && !streaming}
          className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40">
          <Download className="h-3.5 w-3.5" /> Download raw JSONL
        </button>
        <textarea
          placeholder='অথবা এখানে paste করুন…  {"ts":"…","step":"apply_sql","status":"fail",…}'
          className="min-h-[60px] flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
          value={rawLog}
          onChange={(e) => load(e.target.value)}
        />
      </div>


      {summary && (
        <div className="space-y-3">
          <div className={`rounded-md border p-3 text-sm ${
            summary.ok ? "border-green-500/40 bg-green-500/5"
              : summary.rolledBack ? "border-yellow-500/40 bg-yellow-500/5"
              : "border-red-500/40 bg-red-500/5"
          }`}>
            <div className="font-medium">
              Job <code>{summary.jobId}</code> — {summary.ok ? "✔ success" : summary.rolledBack ? "⟲ failed + rolled back" : "✘ failed"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {summary.startedAt} → {summary.endedAt} · steps: {summary.entries.length}
            </div>
            {summary.failedStep && (
              <div className="mt-2 rounded bg-red-500/10 p-2 text-xs">
                <div className="font-semibold text-red-700 dark:text-red-300">Failed step: {summary.failedStep.step}</div>
                <div className="mt-1 font-mono">{summary.failedStep.error ?? "(no error captured)"}</div>
                <div className="mt-1 text-muted-foreground">Fix: run <code>bash rollback.sh {summary.jobId}</code> or inspect <code>db.dump</code> / <code>vol-*.tgz</code> in the snapshot dir.</div>
              </div>
            )}
          </div>

          <ol className="space-y-1">
            {summary.entries.map((e, i) => (
              <li key={i} className="flex items-start gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-xs">
                <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                  e.status === "ok" || e.status === "done" ? "bg-green-500/15 text-green-700 dark:text-green-300"
                    : e.status === "fail" ? "bg-red-500/15 text-red-700 dark:text-red-300"
                    : e.status === "skip" ? "bg-muted text-muted-foreground"
                    : "bg-primary/15 text-primary"
                }`}>{e.status}</span>
                <span className="w-40 shrink-0 font-mono text-muted-foreground">{e.ts}</span>
                <span className="flex-1"><b>{e.step}</b>
                  {e.file && <> · <code>{e.file}</code></>}
                  {e.volume && <> · volume:<code>{e.volume}</code></>}
                  {e.reason && <> · {e.reason}</>}
                  {e.error && <div className="mt-0.5 font-mono text-red-700 dark:text-red-300">{e.error}</div>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {!summary && (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          <AlertTriangle className="mx-auto mb-2 h-6 w-6" />
          কোনো log লোড হয়নি — Auto-detect করুন, ফাইল দিন, অথবা JSONL paste করুন।
        </div>
      )}
    </div>
  );
}

// Pre-apply verification recap — surfaces manifest / checksum results BEFORE
// any script gets a chance to run. Files-checked and mismatches are shown
// explicitly so the operator can bail out at this screen if anything's off.
function PreApplyVerification({ verify }: { verify: VerifyResult | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!verify) {
    return (
      <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 p-3 text-sm">
        <AlertTriangle className="mr-1 inline h-4 w-4 text-yellow-600" />
        Integrity check hasn't run — আপলোড স্টেপ থেকে শুরু করুন।
      </div>
    );
  }
  const ok = verify.entries.filter((e) => e.ok);
  const bad = verify.entries.filter((e) => !e.ok);
  const state = !verify.hasManifest ? "warn" : verify.ok ? "ok" : "bad";
  const border = state === "ok" ? "border-green-500/40 bg-green-500/5"
    : state === "bad" ? "border-red-500/40 bg-red-500/5"
    : "border-yellow-500/40 bg-yellow-500/5";
  return (
    <div className={`rounded-md border p-3 text-sm ${border}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold">
          {state === "ok" ? <ShieldCheck className="h-4 w-4 text-green-600" />
            : state === "bad" ? <ShieldAlert className="h-4 w-4 text-red-600" />
            : <ShieldAlert className="h-4 w-4 text-yellow-600" />}
          Pre-apply verification — {verify.message}
        </div>
        {verify.entries.length > 0 && (
          <button onClick={() => setExpanded((v) => !v)}
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted">
            {expanded ? "hide" : `show all ${verify.entries.length}`}
          </button>
        )}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded bg-background/50 p-2">
          <div className="text-muted-foreground">Files checked</div>
          <div className="text-lg font-bold text-foreground">{verify.entries.length}</div>
        </div>
        <div className="rounded bg-background/50 p-2">
          <div className="text-muted-foreground">Verified ✓</div>
          <div className="text-lg font-bold text-green-700 dark:text-green-300">{ok.length}</div>
        </div>
        <div className="rounded bg-background/50 p-2">
          <div className="text-muted-foreground">Mismatch / missing ✘</div>
          <div className={`text-lg font-bold ${bad.length ? "text-red-700 dark:text-red-300" : "text-foreground"}`}>{bad.length}</div>
        </div>
      </div>
      {bad.length > 0 && <MismatchTable entries={bad} title="apply.sh will refuse to run — mismatches:" defaultSort="component" />}
      {expanded && <MismatchTable entries={verify.entries} title={`All ${verify.entries.length} files`} defaultSort="path" />}
    </div>
  );
}

// Classify each verified/mismatched file by which "component" of the bundle
// it belongs to, so operators can quickly see whether the tampering is in
// SQL vs. scripts vs. frontend vs. metadata.
function componentOf(path: string): { label: string; tone: string } {
  if (/\.sql$/i.test(path)) return { label: "SQL migration", tone: "bg-purple-500/15 text-purple-700 dark:text-purple-300" };
  if (/^(apply|rollback|cancel|serve-progress|install-secrets)\.sh$/i.test(path)) return { label: "restore script", tone: "bg-blue-500/15 text-blue-700 dark:text-blue-300" };
  if (/\.(sh|bash)$/i.test(path)) return { label: "shell script", tone: "bg-blue-500/15 text-blue-700 dark:text-blue-300" };
  if (/\.env|secrets/i.test(path)) return { label: "env / secrets", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300" };
  if (/manifest\.json|SHA256SUMS|snapshot\.json/i.test(path)) return { label: "manifest", tone: "bg-slate-500/15 text-slate-700 dark:text-slate-300" };
  if (/README|REPORT|\.md$/i.test(path)) return { label: "docs", tone: "bg-muted text-muted-foreground" };
  if (/\.(ts|tsx|js|jsx|css|html)$/i.test(path)) return { label: "frontend", tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" };
  if (/db\.config|driver/i.test(path)) return { label: "db config", tone: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300" };
  return { label: "other", tone: "bg-muted text-muted-foreground" };
}

type MismatchRow = { path: string; expected: string; actual: string; ok: boolean };
type SortKey = "path" | "component" | "status";

function MismatchTable({ entries, title, defaultSort }: { entries: MismatchRow[]; title: string; defaultSort: SortKey }) {
  const [sort, setSort] = useState<SortKey>(defaultSort);
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const rows = useMemo(() => {
    const r = entries.map((e) => ({ ...e, component: componentOf(e.path) }));
    r.sort((a, b) => {
      const av = sort === "component" ? a.component.label : sort === "status" ? (a.ok ? "ok" : a.actual ? "mismatch" : "missing") : a.path;
      const bv = sort === "component" ? b.component.label : sort === "status" ? (b.ok ? "ok" : b.actual ? "mismatch" : "missing") : b.path;
      return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return r;
  }, [entries, sort, dir]);
  const toggle = (k: SortKey) => { if (sort === k) setDir(dir === "asc" ? "desc" : "asc"); else { setSort(k); setDir("asc"); } };
  const arrow = (k: SortKey) => sort === k ? (dir === "asc" ? " ▲" : " ▼") : "";
  return (
    <div className="mt-2 rounded border border-border bg-background/40">
      <div className="border-b border-border px-2 py-1 text-xs font-semibold text-foreground">{title}</div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-[11px] font-mono">
          <thead className="sticky top-0 bg-muted text-muted-foreground">
            <tr>
              <th className="cursor-pointer px-2 py-1 text-left" onClick={() => toggle("status")}>·{arrow("status")}</th>
              <th className="cursor-pointer px-2 py-1 text-left" onClick={() => toggle("component")}>Component{arrow("component")}</th>
              <th className="cursor-pointer px-2 py-1 text-left" onClick={() => toggle("path")}>Path{arrow("path")}</th>
              <th className="px-2 py-1 text-left">Expected SHA-256</th>
              <th className="px-2 py-1 text-left">Actual SHA-256</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.path} className={r.ok ? "" : "bg-red-500/5"}>
                <td className="px-2 py-1 align-top">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                    r.ok ? "bg-green-500/15 text-green-700 dark:text-green-300"
                      : r.actual ? "bg-red-500/20 text-red-700 dark:text-red-300"
                      : "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300"
                  }`}>{r.ok ? "ok" : r.actual ? "mismatch" : "missing"}</span>
                </td>
                <td className="px-2 py-1 align-top"><span className={`rounded px-1.5 py-0.5 text-[10px] ${r.component.tone}`}>{r.component.label}</span></td>
                <td className="px-2 py-1 align-top break-all">{r.path}</td>
                <td className="px-2 py-1 align-top text-muted-foreground" title={r.expected}>{r.expected.slice(0, 16)}…</td>
                <td className={`px-2 py-1 align-top ${r.ok ? "text-muted-foreground" : "text-red-700 dark:text-red-300"}`} title={r.actual}>
                  {r.actual ? r.actual.slice(0, 16) + "…" : "(missing)"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


