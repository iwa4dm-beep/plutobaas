import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowRight, Check, CheckCircle2, Copy, Download, FileDown,
  KeyRound, Loader2, Play, Rocket, ShieldCheck, Stethoscope, XCircle,
} from "lucide-react";
import {
  ALL_CHECKS, buildEnvFile, buildReadme, buildReport, downloadText,
  reportToMarkdown, runCheck,
  type CheckId, type CheckResult, type WizardConfig,
} from "@/lib/pluto/connect-wizard";
import { STACK_TEMPLATES } from "@/lib/pluto/stack-templates";

const CFG_KEY = "pluto.connectWizard.config";

const STAGES = [
  { id: "keys", label_en: "URL & keys", label_bn: "URL ও key", icon: KeyRound },
  { id: "cors", label_en: "CORS", label_bn: "CORS", icon: ShieldCheck },
  { id: "import", label_en: "Database import", label_bn: "ডেটাবেজ ইমপোর্ট", icon: Download },
  { id: "verify", label_en: "Verification", label_bn: "ভেরিফিকেশন", icon: Rocket },
] as const;

function statusClasses(s: CheckResult["status"]) {
  switch (s) {
    case "pass": return "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400";
    case "warn": return "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400";
    case "fail": return "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-400";
    case "running": return "border-primary/40 bg-primary/5 text-primary";
    default: return "border-border/60 bg-card/60 text-muted-foreground";
  }
}

function StatusIcon({ s }: { s: CheckResult["status"] }) {
  if (s === "running") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (s === "pass") return <CheckCircle2 className="h-4 w-4" />;
  if (s === "warn") return <AlertTriangle className="h-4 w-4" />;
  if (s === "fail") return <XCircle className="h-4 w-4" />;
  return <span className="h-4 w-4 rounded-full border border-current/40" />;
}

function Field({
  label, hint, value, onChange, placeholder, type = "text", mono = true,
}: {
  label: string; hint?: string; value: string; type?: string; mono?: boolean;
  onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {hint && <span className="ml-2 text-[11px] text-muted-foreground">{hint}</span>}
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 w-full rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary ${mono ? "font-mono" : ""}`}
      />
    </label>
  );
}

function Snip({ lang, file, content }: { lang: string; file: string; content: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-border/60 bg-muted/40">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/60 px-3 py-1.5 text-[11px]">
        <span className="font-mono text-muted-foreground">{file} · {lang}</span>
        <button
          onClick={() => { navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1400); }}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}{copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre p-3 font-mono text-xs leading-relaxed text-foreground/90">{content}</pre>
    </div>
  );
}

export function GuidedSetupWizard({ apiBase }: { apiBase: string }) {
  const [cfg, setCfg] = useState<WizardConfig>({
    apiBase,
    anonKey: "",
    serviceKey: "",
    appOrigin: typeof window !== "undefined" ? window.location.origin : "",
    projectRef: "",
    table: "todos",
    bucket: "avatars",
  });
  const [stage, setStage] = useState(0);
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [running, setRunning] = useState(false);
  const [stack, setStack] = useState(STACK_TEMPLATES[0].id);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (raw) setCfg((c) => ({ ...c, ...JSON.parse(raw) }));
    } catch { /* ignore */ }
  }, []);

  const set = useCallback((patch: Partial<WizardConfig>) => {
    setCfg((prev) => {
      const next = { ...prev, ...patch };
      try {
        const { serviceKey: _drop, ...safe } = next;
        localStorage.setItem(CFG_KEY, JSON.stringify(safe));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  const runOne = useCallback(async (id: CheckId, current: WizardConfig) => {
    setResults((r) => ({
      ...r,
      [id]: { ...(r[id] ?? { id, label: id, label_bn: id, detail: "" }), id, status: "running", detail: "Running…" } as CheckResult,
    }));
    const res = await runCheck(id, current);
    setResults((r) => ({ ...r, [id]: res }));
    return res;
  }, []);

  const runAll = useCallback(async () => {
    setRunning(true);
    for (const id of ALL_CHECKS) await runOne(id, cfg);
    setRunning(false);
    setStage(3);
  }, [cfg, runOne]);

  const ordered = useMemo(
    () => ALL_CHECKS.map((id) => results[id]).filter(Boolean) as CheckResult[],
    [results],
  );
  const report = useMemo(() => buildReport(cfg, ordered), [cfg, ordered]);
  const problems = ordered.filter((c) => c.status === "fail" || c.status === "warn");

  const template = STACK_TEMPLATES.find((t) => t.id === stack) ?? STACK_TEMPLATES[0];
  const fill = (s: string) =>
    s.replaceAll("__API__", cfg.apiBase)
      .replaceAll("__ANON__", cfg.anonKey || "pk_anon_REPLACE_ME")
      .replaceAll("__SERVICE__", cfg.serviceKey || "sk_service_REPLACE_ME")
      .replaceAll("__TABLE__", cfg.table || "todos");

  const downloadBundle = () => {
    downloadText(".env", buildEnvFile(cfg));
    setTimeout(() => downloadText("PLUTO-SETUP.md", buildReadme(cfg), "text/markdown"), 250);
  };

  return (
    <section className="mt-10 space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 pb-2">
        <h2 className="text-lg font-semibold">Guided setup · এক ক্লিকে গাইডেড সেটআপ</h2>
        <span className="text-xs text-muted-foreground">
          URL/keys → CORS → import → verification, একই জায়গা থেকে
        </span>
      </div>

      {/* Stage rail */}
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STAGES.map((s, i) => {
          const Icon = s.icon;
          const active = i === stage;
          const past = i < stage;
          return (
            <li key={s.id}>
              <button
                onClick={() => setStage(i)}
                className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition ${
                  active ? "border-primary bg-primary/10 text-foreground"
                    : past ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                    : "border-border/60 bg-card/60 text-muted-foreground hover:bg-accent"
                }`}
              >
                {past ? <Check className="h-3.5 w-3.5 shrink-0" /> : <Icon className="h-3.5 w-3.5 shrink-0" />}
                <span className="min-w-0 truncate">
                  {i + 1}. {s.label_en} <span className="text-muted-foreground">· {s.label_bn}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {/* Stage 1 — URL & keys */}
      {stage === 0 && (
        <div className="rounded-lg border border-border/60 bg-card/60 p-5">
          <h3 className="text-sm font-semibold">1. API URL &amp; keys · URL ও key</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Projects &amp; Keys থেকে anon + service_role key কপি করে এখানে বসান। service key শুধু ব্রাউজারে
            এই সেশনে থাকে — কোথাও সংরক্ষণ হয় না।
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="API base URL" value={cfg.apiBase} onChange={(v) => set({ apiBase: v })} placeholder="https://api.example.com" />
            <Field label="App origin" hint="your frontend" value={cfg.appOrigin} onChange={(v) => set({ appOrigin: v })} placeholder="https://app.example.com" />
            <Field label="anon key" hint="public" value={cfg.anonKey} onChange={(v) => set({ anonKey: v })} placeholder="pk_anon_…" />
            <Field label="service_role key" hint="not persisted" type="password" value={cfg.serviceKey} onChange={(v) => set({ serviceKey: v })} placeholder="sk_service_…" />
            <Field label="Project ref" value={cfg.projectRef} onChange={(v) => set({ projectRef: v })} placeholder="my-project" />
            <Field label="Probe table" hint="used by RLS/import checks" value={cfg.table} onChange={(v) => set({ table: v })} placeholder="todos" />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => runOne("keys", cfg)} className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-accent">
              <Play className="h-3 w-3" /> Validate keys
            </button>
            <Link to="/dashboard/api" className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-accent">Open Projects &amp; Keys</Link>
            <button onClick={() => setStage(1)} className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">
              Next: CORS <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {results.keys && (
            <div className={`mt-3 rounded-md border p-3 text-xs ${statusClasses(results.keys.status)}`}>
              <div className="flex items-center gap-2 font-medium"><StatusIcon s={results.keys.status} />{results.keys.label}</div>
              <pre className="mt-1 whitespace-pre-wrap break-all font-mono">{results.keys.detail}</pre>
            </div>
          )}
        </div>
      )}

      {/* Stage 2 — CORS */}
      {stage === 1 && (
        <div className="rounded-lg border border-border/60 bg-card/60 p-5">
          <h3 className="text-sm font-semibold">2. CORS whitelist</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            ঠিক এই origin-টি whitelist-এ থাকতে হবে (scheme + host + port, শেষে slash ছাড়া):
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{cfg.appOrigin || "—"}</code>
            <button onClick={() => navigator.clipboard.writeText(cfg.appOrigin)} className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs hover:bg-accent">
              <Copy className="h-3 w-3" /> Copy
            </button>
            <Link to="/dashboard/cors" className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs hover:bg-accent">Open CORS page</Link>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={() => runOne("cors", cfg)} className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-accent">
              <Play className="h-3 w-3" /> Test from this origin
            </button>
            <button onClick={() => setStage(2)} className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">
              Next: import <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {results.cors && (
            <div className={`mt-3 rounded-md border p-3 text-xs ${statusClasses(results.cors.status)}`}>
              <div className="flex items-center gap-2 font-medium"><StatusIcon s={results.cors.status} />{results.cors.label}</div>
              <pre className="mt-1 whitespace-pre-wrap break-all font-mono">{results.cors.detail}</pre>
            </div>
          )}
        </div>
      )}

      {/* Stage 3 — Import */}
      {stage === 2 && (
        <div className="rounded-lg border border-border/60 bg-card/60 p-5">
          <h3 className="text-sm font-semibold">3. Database import · ডেটাবেজ ইমপোর্ট</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Supabase dump বা SQL ফাইল Migrator দিয়ে আনুন, apply করুন, তারপর নিচের probe দিয়ে
            টেবিলটি সত্যিই এসেছে কিনা যাচাই করুন।
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link to="/dashboard/database-import" className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-accent">Open Database import</Link>
            <Link to="/dashboard/import-audit" className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-accent">Import audit history</Link>
            <button onClick={() => runOne("import", cfg)} className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-accent">
              <Play className="h-3 w-3" /> Probe “{cfg.table || "todos"}”
            </button>
            <button onClick={runAll} disabled={running} className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Rocket className="h-3 w-3" />} Run full verification
            </button>
          </div>
          {results.import && (
            <div className={`mt-3 rounded-md border p-3 text-xs ${statusClasses(results.import.status)}`}>
              <div className="flex items-center gap-2 font-medium"><StatusIcon s={results.import.status} />{results.import.label}</div>
              <pre className="mt-1 whitespace-pre-wrap break-all font-mono">{results.import.detail}</pre>
            </div>
          )}
        </div>
      )}

      {/* Stage 4 — Verification report */}
      {stage === 3 && (
        <div className="rounded-lg border border-border/60 bg-card/60 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">4. Verification report · ভেরিফিকেশন রিপোর্ট</h3>
            <div className="flex flex-wrap gap-2">
              <button onClick={runAll} disabled={running} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run all checks
              </button>
              <button
                onClick={() => downloadText(`pluto-verification-${Date.now()}.json`, JSON.stringify(report, null, 2), "application/json")}
                disabled={!ordered.length}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
              >
                <FileDown className="h-3 w-3" /> JSON
              </button>
              <button
                onClick={() => downloadText(`pluto-verification-${Date.now()}.md`, reportToMarkdown(report), "text/markdown")}
                disabled={!ordered.length}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
              >
                <FileDown className="h-3 w-3" /> Markdown
              </button>
            </div>
          </div>

          {ordered.length > 0 && (
            <div className={`mt-3 rounded-md border p-3 text-xs ${
              report.overall === "pass" ? statusClasses("pass")
                : report.overall === "warn" ? statusClasses("warn") : statusClasses("fail")
            }`}>
              <span className="font-medium">Overall: {report.overall.toUpperCase()}</span>{" "}
              — {report.summary.pass} pass · {report.summary.warn} warn · {report.summary.fail} fail
            </div>
          )}

          <ul className="mt-3 space-y-2">
            {ALL_CHECKS.map((id) => {
              const r = results[id];
              return (
                <li key={id} className={`rounded-md border p-3 text-xs ${statusClasses(r?.status ?? "idle")}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2 font-medium">
                      <StatusIcon s={r?.status ?? "idle"} />
                      <span className="truncate">{r?.label ?? id}</span>
                      <span className="truncate text-muted-foreground">· {r?.label_bn ?? ""}</span>
                    </div>
                    <button onClick={() => runOne(id, cfg)} className="shrink-0 rounded border border-current/30 px-2 py-0.5 text-[11px] hover:bg-accent/40">
                      Re-run
                    </button>
                  </div>
                  {r?.detail && <pre className="mt-1 whitespace-pre-wrap break-all font-mono opacity-90">{r.detail}</pre>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Download bundle */}
      <div className="rounded-lg border border-border/60 bg-card/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Download .env + usage guide · এক জায়গা থেকে ডাউনলোড</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              পূর্ণ `.env` (Vite + Next + server) এবং `PLUTO-SETUP.md` নির্দেশিকা — উপরের মানগুলো থেকেই তৈরি।
            </p>
          </div>
          <button onClick={downloadBundle} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">
            <Download className="h-3 w-3" /> Download bundle
          </button>
        </div>
        <Snip file=".env" lang="env" content={buildEnvFile(cfg)} />
      </div>

      {/* Stack templates */}
      <div className="rounded-lg border border-border/60 bg-card/60 p-5">
        <h3 className="text-sm font-semibold">Stack templates · স্ট্যাকভিত্তিক কনফিগ</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {STACK_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => setStack(t.id)}
              className={`rounded-md border px-3 py-1.5 text-xs transition ${
                t.id === stack ? "border-primary bg-primary/10 text-foreground" : "border-border/60 hover:bg-accent"
              }`}
            >
              {t.name}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{template.blurb_en}</p>
        <p className="text-xs text-muted-foreground">{template.blurb_bn}</p>
        <Snip file="install" lang="bash" content={template.install} />
        {template.snippets.map((s) => (
          <Snip key={s.file + s.lang} file={s.file} lang={s.lang} content={fill(s.content)} />
        ))}
      </div>

      {/* Diagnostics */}
      <div className="rounded-lg border border-border/60 bg-card/60 p-5">
        <div className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Diagnostics · সম্ভাব্য কারণ ও সমাধান</h3>
        </div>
        {problems.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {ordered.length === 0
              ? "কোনো চেক এখনো চালানো হয়নি — উপরে “Run all checks” চাপুন।"
              : "কোনো সমস্যা পাওয়া যায়নি — সব চেক পাস করেছে।"}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {problems.map((c) => (
              <li key={c.id} className={`rounded-md border p-3 text-xs ${statusClasses(c.status)}`}>
                <div className="flex items-center gap-2 font-medium"><StatusIcon s={c.status} />{c.label} · {c.label_bn}</div>
                <pre className="mt-1 whitespace-pre-wrap break-all font-mono opacity-90">{c.detail}</pre>
                <div className="mt-2 space-y-2">
                  {c.hints?.map((h, i) => (
                    <div key={i} className="rounded border border-border/50 bg-background/60 p-2 text-foreground">
                      <div><span className="font-medium">Cause:</span> {h.cause}</div>
                      <div className="text-muted-foreground">{h.cause_bn}</div>
                      <div className="mt-1"><span className="font-medium">Fix:</span> {h.fix}</div>
                      <div className="text-muted-foreground">{h.fix_bn}</div>
                      {h.link && (
                        <a href={h.link} className="mt-1 inline-flex items-center gap-1 text-primary hover:underline">
                          Open {h.link} <ArrowRight className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
