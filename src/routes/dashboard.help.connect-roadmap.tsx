import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight, Bell, CheckCircle2, CircleAlert, CircleDashed, Download, Loader2, Play, RotateCcw, Rocket, Square, XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { resolveApiUrl } from "@/lib/pluto/base-url";
import {
  downloadText,
  runCheck,
  type CheckId,
  type CheckResult,
  type WizardConfig,
} from "@/lib/pluto/connect-wizard";
import {
  goLiveReportToMarkdown,
  runGoLive,
  type GoLiveReport,
  type RunEvent,
  type StageOutcome,
  type StageSpec,
} from "@/lib/pluto/go-live-runner";
import {
  EMPTY_NOTIFY,
  loadNotifyConfig,
  notifyGoLive,
  saveNotifyConfig,
  type NotifyConfig,
  type NotifyOutcome,
} from "@/lib/pluto/go-live-notify";


export const Route = createFileRoute("/dashboard/help/connect-roadmap")({
  component: ConnectRoadmapPage,
  head: () => ({
    meta: [
      { title: "Connect & Go-Live Roadmap — Pluto BaaS" },
      {
        name: "description",
        content:
          "Ten-step roadmap that maps every Pluto BaaS dashboard page you need to connect a project backend and take it live, with one-click live checks.",
      },
      { property: "og:title", content: "Connect & Go-Live Roadmap — Pluto BaaS" },
      {
        property: "og:description",
        content:
          "Which dashboard page to use at each step, from workspace creation to a verified live deployment.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const CFG_KEY = "pluto.connectWizard.config";
const DONE_KEY = "pluto.connectRoadmap.done";

type Stop = { to: string; label: string };

type Step = {
  id: string;
  n: number;
  title_en: string;
  title_bn: string;
  outcome_en: string;
  outcome_bn: string;
  stops: Stop[];
  check?: CheckId;
};

const STEPS: Step[] = [
  {
    id: "workspace",
    n: 1,
    title_en: "Create workspace + project",
    title_bn: "Workspace ও প্রজেক্ট তৈরি",
    outcome_en: "A project slug that owns your database, keys and quotas.",
    outcome_bn: "একটি project slug — যার অধীনে ডেটাবেজ, key ও quota থাকবে।",
    stops: [
      { to: "/dashboard/workspaces", label: "Workspaces" },
      { to: "/dashboard/projects", label: "Projects" },
    ],
  },
  {
    id: "connect",
    n: 2,
    title_en: "Run the guided connection wizard",
    title_bn: "গাইডেড কানেকশন উইজার্ড চালান",
    outcome_en: "URL + keys entered, CORS set, import triggered, 8 probes green.",
    outcome_bn: "URL + key, CORS, ইমপোর্ট ও ৮টি probe — সব এক জায়গায়।",
    stops: [{ to: "/dashboard/connect-project", label: "Connect your project" }],
    check: "health",
  },
  {
    id: "keys",
    n: 3,
    title_en: "Mint API keys (and plan rotation)",
    title_bn: "API key তৈরি ও রোটেশন পরিকল্পনা",
    outcome_en: "A public anon key for the browser and a server-only service key.",
    outcome_bn: "ব্রাউজারের জন্য anon key, সার্ভারের জন্য service key।",
    stops: [
      { to: "/dashboard/api", label: "API & keys" },
      { to: "/dashboard/key-rotation", label: "Key rotation" },
    ],
    check: "keys",
  },
  {
    id: "cors",
    n: 4,
    title_en: "Allow your frontend origin",
    title_bn: "ফ্রন্টএন্ড origin অনুমোদন",
    outcome_en: "Your exact origin (scheme + host + port) on the allow-list.",
    outcome_bn: "হুবহু origin (scheme + host + port) allow-list-এ যুক্ত।",
    stops: [{ to: "/dashboard/cors", label: "CORS origins" }],
    check: "cors",
  },
  {
    id: "data",
    n: 5,
    title_en: "Import schema and data",
    title_bn: "স্কিমা ও ডেটা ইমপোর্ট",
    outcome_en: "Tables, views and rows applied — with a verifiable audit trail.",
    outcome_bn: "টেবিল/ভিউ/রো apply হয়েছে — অডিট ট্রেইলসহ।",
    stops: [
      { to: "/dashboard/database-import", label: "Database import" },
      { to: "/dashboard/sql", label: "SQL editor" },
      { to: "/dashboard/import-audit", label: "Import audit" },
    ],
    check: "import",
  },
  {
    id: "rls",
    n: 6,
    title_en: "Lock down auth, RBAC and RLS",
    title_bn: "Auth, RBAC ও RLS নিরাপদ করুন",
    outcome_en: "Private tables reject the anon key; roles behave as designed.",
    outcome_bn: "প্রাইভেট টেবিলে anon key প্রত্যাখ্যাত; role ঠিকভাবে কাজ করছে।",
    stops: [
      { to: "/dashboard/rbac-templates", label: "RBAC templates" },
      { to: "/dashboard/rbac-debug", label: "RBAC debug" },
      { to: "/dashboard/ops/rls-debug", label: "RLS debug" },
    ],
    check: "rls",
  },
  {
    id: "modules",
    n: 7,
    title_en: "Turn on storage, realtime, functions",
    title_bn: "Storage, Realtime, Functions চালু",
    outcome_en: "Buckets created, websocket channel reachable, edge functions deployed.",
    outcome_bn: "বাকেট তৈরি, websocket চ্যানেল সচল, edge function ডিপ্লয়েড।",
    stops: [
      { to: "/dashboard/storage", label: "Storage" },
      { to: "/dashboard/realtime", label: "Realtime" },
      { to: "/dashboard/functions", label: "Functions" },
    ],
    check: "storage",
  },
  {
    id: "local",
    n: 8,
    title_en: "Optional: mirror the stack locally",
    title_bn: "ঐচ্ছিক: লোকালে একই স্ট্যাক",
    outcome_en: "A docker-compose bundle that boots the same backend on your machine.",
    outcome_bn: "docker-compose বান্ডল — নিজের মেশিনে একই ব্যাকএন্ড।",
    stops: [{ to: "/dashboard/local-stack", label: "Local stack" }],
  },
  {
    id: "deploy",
    n: 9,
    title_en: "Deploy the frontend and bind the domain",
    title_bn: "ফ্রন্টএন্ড ডিপ্লয় ও ডোমেইন যুক্ত",
    outcome_en: "Live site on your domain with TLS and the primary-frontend header.",
    outcome_bn: "TLS ও primary-frontend হেডারসহ আপনার ডোমেইনে লাইভ সাইট।",
    stops: [
      { to: "/dashboard/auto-deploy", label: "Auto-deploy" },
      { to: "/dashboard/custom-domains", label: "Custom domains" },
    ],
  },
  {
    id: "verify",
    n: 10,
    title_en: "Verify and keep watching",
    title_bn: "ভেরিফাই ও মনিটরিং",
    outcome_en: "Green backend status, live logs, and traces after go-live.",
    outcome_bn: "সবুজ backend status, লাইভ লগ ও trace।",
    stops: [
      { to: "/dashboard/backend-status", label: "Backend status" },
      { to: "/dashboard/observability", label: "Observability" },
      { to: "/dashboard/logs-explorer", label: "Logs explorer" },
    ],
    check: "realtime",
  },
];

function StatusIcon({ r }: { r?: CheckResult }) {
  if (!r) return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
  if (r.status === "running") return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (r.status === "pass") return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (r.status === "warn") return <CircleAlert className="h-4 w-4 text-amber-500" />;
  if (r.status === "fail") return <XCircle className="h-4 w-4 text-destructive" />;
  return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
}

function ConnectRoadmapPage() {
  const [cfg, setCfg] = useState<WizardConfig | null>(null);
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [stageMap, setStageMap] = useState<Record<string, StageOutcome>>({});
  const [report, setReport] = useState<GoLiveReport | null>(null);
  const [notify, setNotify] = useState<NotifyConfig>(EMPTY_NOTIFY);
  const [notifyStatus, setNotifyStatus] = useState<NotifyOutcome | null>(null);
  const [showNotify, setShowNotify] = useState(false);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const stopRef = useRef(false);
  const stagesRef = useRef<Record<string, StageOutcome>>({});

  const applyBaseline = useCallback(async () => {
    setBaselineBusy(true);
    const push = (level: RunEvent["level"], message: string) =>
      setEvents((prev) => [...prev, { at: new Date().toISOString(), stage: "baseline", level, message }]);
    push("info", "Applying the Pluto baseline schema (profiles, user_roles, todos, grants, RLS, realtime)…");
    try {
      const r = await applyBaselineSchema({ onLog: (m) => push("info", m) });
      push(r.ok ? "ok" : "error", r.detail);
    } finally {
      setBaselineBusy(false);
    }
  }, []);



  useEffect(() => {
    const apiBase = resolveApiUrl();
    let stored: Partial<WizardConfig> = {};
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (raw) stored = JSON.parse(raw) as Partial<WizardConfig>;
    } catch { /* ignore */ }
    setCfg({
      apiBase,
      anonKey: "",
      serviceKey: "",
      appOrigin: window.location.origin,
      projectRef: "",
      table: "todos",
      bucket: "avatars",
      ...stored,
    });
    try {
      const raw = localStorage.getItem(DONE_KEY);
      if (raw) setDone(JSON.parse(raw) as Record<string, boolean>);
    } catch { /* ignore */ }
    setNotify(loadNotifyConfig());
  }, []);

  const updateNotify = useCallback((patch: Partial<NotifyConfig>) => {
    setNotify((prev) => {
      const next = { ...prev, ...patch };
      saveNotifyConfig(next);
      return next;
    });
  }, []);

  const toggleDone = useCallback((id: string) => {
    setDone((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try { localStorage.setItem(DONE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const runOne = useCallback(
    async (step: Step) => {
      if (!step.check || !cfg) return;
      const id = step.check;
      setResults((r) => ({
        ...r,
        [step.id]: { ...(r[step.id] ?? { id, label: id, label_bn: id, detail: "" }), id, status: "running", detail: "Running…" } as CheckResult,
      }));
      const res = await runCheck(id, cfg);
      setResults((r) => ({ ...r, [step.id]: res }));
    },
    [cfg],
  );

  const runAll = useCallback(async () => {
    if (!cfg) return;
    setBusy(true);
    for (const s of STEPS) if (s.check) await runOne(s);
    setBusy(false);
  }, [cfg, runOne]);

  const runFullGoLive = useCallback(
    async (resume = false) => {
      if (!cfg) return;
      stopRef.current = false;
      setAuto(true);
      setEvents([]);
      setReport(null);
      setNotifyStatus(null);
      if (!resume) {
        stagesRef.current = {};
        setStageMap({});
        setResults({});
      }

      const specs: StageSpec[] = STEPS.map((s) => ({
        id: s.id,
        n: s.n,
        title: s.title_en,
        title_bn: s.title_bn,
        check: s.check,
        page: s.stops[0]?.to ?? "/dashboard",
      }));

      const rep = await runGoLive(
        specs,
        cfg,
        {
          shouldStop: () => stopRef.current,
          onEvent: (e) => setEvents((prev) => [...prev, e]),
          onStage: (o) => {
            if (o.status !== "running") stagesRef.current[o.id] = o;
            setStageMap((prev) => ({ ...prev, [o.id]: o }));
            setResults((prev) => ({
              ...prev,
              [o.id]: {
                id: (STEPS.find((s) => s.id === o.id)?.check ?? "health") as CheckId,
                label: o.title,
                label_bn: o.title,
                status:
                  o.status === "manual" || o.status === "skipped"
                    ? "skipped"
                    : o.status === "running"
                      ? "running"
                      : o.status,
                detail: o.detail,
                hints: o.hints,
                evidence: o.evidence,
              } as CheckResult,
            }));
            if (o.status === "pass") {
              setDone((prev) => {
                const next = { ...prev, [o.id]: true };
                try { localStorage.setItem(DONE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
                return next;
              });
            }
          },
        },
        { resume, previous: resume ? { ...stagesRef.current } : undefined },
      );

      setReport(rep);
      setAuto(false);
      setNotifyStatus(await notifyGoLive(rep, notify));
    },
    [cfg, notify],
  );

  const checkable = STEPS.filter((s) => s.check).length;
  const passed = STEPS.filter((s) => results[s.id]?.status === "pass").length;
  const completed = STEPS.filter((s) => done[s.id]).length;
  const autoProgress = Object.values(stageMap).filter((s) => s.status !== "running").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connect & Go-Live Roadmap"
        description="প্রজেক্টের ব্যাকএন্ড Pluto BaaS-এ যুক্ত করে লাইভ করার ১০ ধাপ — প্রতিটি ধাপের জন্য কোন পেইজ, কী ফলাফল, আর লাইভ চেক।"
      />

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4">
        <div className="text-sm">
          <span className="font-medium text-foreground">{completed}/{STEPS.length}</span>
          <span className="text-muted-foreground"> steps marked done</span>
          <span className="mx-2 text-border">·</span>
          <span className="font-medium text-foreground">{passed}/{checkable}</span>
          <span className="text-muted-foreground"> live checks passing</span>
          {auto && (
            <>
              <span className="mx-2 text-border">·</span>
              <span className="text-muted-foreground">auto-run {autoProgress}/{STEPS.length}</span>
            </>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Link
            to="/dashboard/connect-project"
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-accent"
          >
            Open wizard <ArrowRight className="h-3 w-3" />
          </Link>
          <button
            onClick={runAll}
            disabled={busy || auto || !cfg}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-accent disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run all checks
          </button>
          <button
            onClick={() => void applyBaseline()}
            disabled={busy || auto || baselineBusy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-accent disabled:opacity-50"
            title="Applies the idempotent baseline schema (profiles, user_roles, todos, grants, RLS, realtime)."
          >
            {baselineBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Apply baseline schema
          </button>

          {auto ? (
            <button
              onClick={() => { stopRef.current = true; }}
              className="inline-flex items-center gap-1.5 rounded-md border border-destructive/50 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/10"
            >
              <Square className="h-3.5 w-3.5" /> Stop
            </button>
          ) : (
            <>
              {Object.keys(stagesRef.current).length > 0 && (
                <button
                  onClick={() => void runFullGoLive(true)}
                  disabled={busy || !cfg}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-accent disabled:opacity-50"
                  title="Skips steps that already passed and continues from the first unresolved step."
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Resume from last step
                </button>
              )}
              <button
                onClick={() => setShowNotify((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-accent"
              >
                <Bell className="h-3.5 w-3.5" />
                {notify.webhookUrl ? "Alerts on" : "Alerts"}
              </button>
              <button
                onClick={() => void runFullGoLive(false)}
                disabled={busy || !cfg}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                <Rocket className="h-3.5 w-3.5" /> Run full go-live (১→১০)
              </button>
            </>
          )}
        </div>
      </div>

      {showNotify && (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Run completion alerts</h2>
          <p className="text-xs text-muted-foreground">
            রান শেষ হলে (সফল বা ব্যর্থ) নিচের webhook URL-এ JSON payload যাবে — verdict, totals, আর প্রথম ব্যর্থ
            ধাপের নম্বরসহ। ইমেইল ঠিকানা দিলে সেটি payload-এর <code>email</code> ফিল্ডে যাবে, যাতে আপনার automation
            (Zapier / n8n / নিজের handler) মেইল পাঠাতে পারে।
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs">
              <span className="text-muted-foreground">Webhook URL</span>
              <input
                value={notify.webhookUrl}
                onChange={(e) => updateNotify({ webhookUrl: e.target.value })}
                placeholder="https://hooks.example.com/pluto-go-live"
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px]"
              />
            </label>
            <label className="text-xs">
              <span className="text-muted-foreground">Alert email (forwarded in payload)</span>
              <input
                value={notify.email}
                onChange={(e) => updateNotify({ email: e.target.value })}
                placeholder="ops@yourdomain.com"
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px]"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={notify.onFailureOnly}
              onChange={(e) => updateNotify({ onFailureOnly: e.target.checked })}
              className="h-3.5 w-3.5 accent-primary"
            />
            Only alert when the run fails
          </label>
          {notifyStatus && (
            <p
              className={
                "text-[11px] " +
                (notifyStatus.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")
              }
            >
              {notifyStatus.detail}
            </p>
          )}
        </section>
      )}



      {(events.length > 0 || report) && (
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold text-foreground">Auto-run timeline</h2>
            {report && (
              <span
                className={
                  "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                  (report.verdict === "green"
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : report.verdict === "amber"
                      ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      : "bg-destructive/15 text-destructive")
                }
              >
                {report.verdict.toUpperCase()} · {report.totals.pass} pass / {report.totals.warn} warn /{" "}
                {report.totals.fail} fail / {report.totals.manual} manual
              </span>
            )}
            {report && (
              <div className="ml-auto flex gap-2">
                <button
                  onClick={() =>
                    downloadText(
                      `pluto-go-live-${Date.now()}.json`,
                      JSON.stringify(report, null, 2),
                      "application/json",
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs transition hover:bg-accent"
                >
                  <Download className="h-3 w-3" /> JSON
                </button>
                <button
                  onClick={() =>
                    downloadText(
                      `pluto-go-live-${Date.now()}.md`,
                      goLiveReportToMarkdown(report),
                      "text/markdown",
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs transition hover:bg-accent"
                >
                  <Download className="h-3 w-3" /> Markdown
                </button>
              </div>
            )}
          </div>
          {report?.failedStep != null && (
            <p className="mt-2 text-[11px] text-destructive">
              First failure at step {report.failedStep} — fix the hint on that step card, then use “Resume from last
              step” to continue without rerunning passed checks.
            </p>
          )}
          <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto rounded-md bg-muted/50 p-3">
            {events.map((e, i) => (
              <li
                key={i}
                className={
                  "font-mono text-[11px] leading-relaxed " +
                  (e.level === "ok"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : e.level === "warn"
                      ? "text-amber-600 dark:text-amber-400"
                      : e.level === "error"
                        ? "text-destructive"
                        : "text-muted-foreground")
                }
              >
                {e.at.slice(11, 19)} [{e.stage}] {e.message}
              </li>
            ))}
            {events.length === 0 && (
              <li className="text-[11px] text-muted-foreground">Waiting for the first stage…</li>
            )}
          </ul>
        </section>
      )}


      {cfg && !cfg.anonKey && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          No anon key saved yet — key-dependent checks will warn. Enter your keys once in the{" "}
          <Link to="/dashboard/connect-project" className="underline">guided wizard</Link> and they are reused here.
        </p>
      )}

      <ol className="space-y-3">
        {STEPS.map((s) => {
          const r = results[s.id];
          return (
            <li key={s.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-start gap-3">
                <input
                  type="checkbox"
                  checked={!!done[s.id]}
                  onChange={() => toggleDone(s.id)}
                  aria-label={`Mark step ${s.n} done`}
                  className="mt-1 h-4 w-4 accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-semibold text-foreground">
                    {s.n}. {s.title_en}
                  </h2>
                  <p className="text-xs text-muted-foreground">{s.title_bn}</p>
                  <p className="mt-2 text-xs text-foreground/80">{s.outcome_en}</p>
                  <p className="text-xs text-muted-foreground">{s.outcome_bn}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {s.stops.map((st) => (
                      <Link
                        key={st.to}
                        to={st.to}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
                      >
                        {st.label} <ArrowRight className="h-3 w-3" />
                      </Link>
                    ))}
                  </div>
                </div>
                {s.check && (
                  <div className="flex items-center gap-2">
                    <StatusIcon r={r} />
                    <button
                      onClick={() => runOne(s)}
                      disabled={!cfg || r?.status === "running"}
                      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium transition hover:bg-accent disabled:opacity-50"
                    >
                      Run check
                    </button>
                  </div>
                )}
              </div>

              {r && r.status !== "running" && (
                <div className="mt-3 rounded-md bg-muted/50 p-3">
                  <p className="font-mono text-[11px] leading-relaxed text-foreground/80">{r.detail}</p>

                  {r.evidence && (
                    <pre className="mt-2 overflow-x-auto rounded bg-background/70 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
{`${r.evidence.method} ${r.evidence.url}
→ HTTP ${r.evidence.status} · ${r.evidence.latencyMs}ms${r.evidence.error ? `\nerror: ${r.evidence.error}` : ""}${r.evidence.bodyPreview ? `\n${r.evidence.bodyPreview}` : ""}`}
                    </pre>
                  )}

                  {(r.status === "fail" || r.status === "warn") && r.hints && r.hints.length > 0 && (
                    <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
                      <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                        Fix this before rerunning · রিরান করার আগে এটি ঠিক করুন
                      </p>
                      {r.hints.map((h, i) => (
                        <div key={i} className="mt-2 border-l-2 border-amber-500/50 pl-2 text-[11px]">
                          <p className="text-foreground/90">{h.cause}</p>
                          <p className="text-muted-foreground">{h.cause_bn}</p>
                          <p className="mt-1 text-foreground/90">→ {h.fix}</p>
                          <p className="text-muted-foreground">→ {h.fix_bn}</p>
                          {h.link && (
                            <Link to={h.link} className="mt-1 inline-flex items-center gap-1 text-primary underline">
                              Open fix page <ArrowRight className="h-3 w-3" />
                            </Link>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {stageMap[s.id]?.logs?.length ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground">Step logs</summary>
                      <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/70 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
{stageMap[s.id]!.logs!.join("\n")}
                      </pre>
                    </details>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
