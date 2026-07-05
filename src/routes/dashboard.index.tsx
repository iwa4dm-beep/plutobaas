import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Activity, ArrowUpRight, CheckCircle2, Database, Files, Heart, KeyRound, Radio,
  ScrollText, ShieldCheck, Sparkles, Terminal, Users, Waves, XCircle,
} from "lucide-react";

import { pluto } from "@/lib/pluto/client";
import { isLive, live } from "@/lib/pluto/live";
import { OnboardingWizard, type Plan } from "@/components/pluto/OnboardingWizard";

const API_BASE = (import.meta.env.VITE_PLUTO_API_URL as string) || "https://api.timescard.cloud";

const STORAGE_KEY = "pluto.onboarding.v1";

function readPersistedPlan(): Plan | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as { plan?: unknown };
    return raw.plan === "self-hosted" || raw.plan === "starter" || raw.plan === "business"
      ? raw.plan
      : undefined;
  } catch { return undefined; }
}

const PLAN_SEO: Record<Plan, { title: string; description: string }> = {
  "self-hosted": {
    title: "Self-Hosted onboarding — Pluto BaaS Dashboard",
    description: "Set up a self-hosted Pluto instance with Docker Compose, Fly, Railway or Render. MIT-licensed, unlimited scale, generated .env in 4 steps.",
  },
  starter: {
    title: "Cloud Starter onboarding — Pluto BaaS Dashboard",
    description: "Launch a managed Pluto Cloud Starter project — 10k MAU, 10 GB Postgres, 500k Edge invocations, 1-click deploy to Fly or Railway.",
  },
  business: {
    title: "Business onboarding — Pluto BaaS Dashboard",
    description: "Provision Pluto Business — 100k MAU, read replicas, SAML SSO, audit log export, dedicated regions on Render or Fly.",
  },
};
const DEFAULT_SEO = {
  title: "Dashboard — Pluto BaaS",
  description: "Manage your Pluto BaaS projects: users, tables, storage buckets, logs, keys, RLS and more.",
};

export const Route = createFileRoute("/dashboard/")({
  validateSearch: (s: Record<string, unknown>): { plan?: Plan } => {
    const p = s.plan;
    return p === "self-hosted" || p === "starter" || p === "business" ? { plan: p } : {};
  },
  loaderDeps: ({ search }) => ({ plan: search.plan }),
  loader: ({ deps }) => ({ plan: deps.plan }),
  head: ({ loaderData }) => {
    const plan = loaderData?.plan;
    const seo = plan ? PLAN_SEO[plan] : DEFAULT_SEO;
    const url = plan
      ? `https://backend-joy.lovable.app/dashboard?plan=${plan}`
      : "https://backend-joy.lovable.app/dashboard";
    return {
      meta: [
        { title: seo.title },
        { name: "description", content: seo.description },
        { name: "robots", content: "noindex" },
        { property: "og:title", content: seo.title },
        { property: "og:description", content: seo.description },
        { property: "og:type", content: "website" },
        { property: "og:url", content: url },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: seo.title },
        { name: "twitter:description", content: seo.description },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
  component: Overview,
});

function Overview() {
  const search = Route.useSearch() as { plan?: Plan };
  const navigate = Route.useNavigate();
  const [stats, setStats] = useState({ users: 0, tables: 0, buckets: 0, logs: 0 });
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState<"mock" | "live">(isLive() ? "live" : "mock");

  // Live health probe against the real backend (api.timescard.cloud)
  type HealthState = { live: boolean | null; ready: boolean | null; mig: boolean | null; ms: number | null };
  const [health, setHealth] = useState<HealthState>({ live: null, ready: null, mig: null, ms: null });

  const [dismissed, setDismissed] = useState(false);
  const [persistedPlan, setPersistedPlan] = useState<Plan | undefined>(undefined);
  useEffect(() => { setPersistedPlan(readPersistedPlan()); }, []);
  const activePlan: Plan | undefined = search.plan ?? persistedPlan;

  useEffect(() => {
    (async () => {
      try {
        if (isLive()) {
          const [s, l, sch] = await Promise.all([
            live.admin.stats(),
            live.admin.logs({ limit: 100 }),
            live.schema.introspect().catch(() => ({ tables: [] as unknown[] })),
          ]);
          setStats({ users: s.users, tables: sch.tables.length, buckets: s.buckets, logs: l.length });
          setSource("live");
        } else {
          const [u, t, b, l] = await Promise.all([
            pluto.users.list(), pluto.db.listTables(),
            pluto.storage.listBuckets(), pluto.logs.list(),
          ]);
          setStats({ users: u.length, tables: t.length, buckets: b.length, logs: l.length });
        }
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      finally { setLoaded(true); }
    })();
  }, []);

  // Poll the real backend's public health endpoints every 30s
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const t0 = performance.now();
      const check = async (path: string) => {
        try {
          const r = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
          if (!r.ok) return false;
          const j = await r.json().catch(() => ({} as any));
          const s = (j as any).status;
          return s === "ok" || s === "ready";
        } catch { return false; }
      };
      const [l, r, m] = await Promise.all([check("/livez"), check("/readyz"), check("/health/migrations")]);
      if (!cancelled) setHealth({ live: l, ready: r, mig: m, ms: Math.round(performance.now() - t0) });
    };
    probe();
    const id = setInterval(probe, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Accent hues drawn from theme's chart tokens for a consistent, meaningful palette:
  // users = identity (chart-1), tables = data (chart-2), buckets = files (chart-4), logs = activity (chart-5).
  const cards: {
    label: string; value: number; icon: typeof Users; hint: string;
    to: "/dashboard/users" | "/dashboard/database" | "/dashboard/storage" | "/dashboard/logs";
    accent: string; ring: string; text: string;
  }[] = [
    { label: "Users",       value: stats.users,   icon: Users,      hint: "active accounts",   to: "/dashboard/users",    accent: "bg-[color-mix(in_oklab,var(--chart-1)_14%,transparent)]", ring: "ring-[color-mix(in_oklab,var(--chart-1)_35%,transparent)]", text: "text-[var(--chart-1)]" },
    { label: "Tables",      value: stats.tables,  icon: Database,   hint: "public schema",     to: "/dashboard/database", accent: "bg-[color-mix(in_oklab,var(--chart-2)_14%,transparent)]", ring: "ring-[color-mix(in_oklab,var(--chart-2)_35%,transparent)]", text: "text-[var(--chart-2)]" },
    { label: "Buckets",     value: stats.buckets, icon: Files,      hint: "storage volumes",   to: "/dashboard/storage",  accent: "bg-[color-mix(in_oklab,var(--chart-4)_14%,transparent)]", ring: "ring-[color-mix(in_oklab,var(--chart-4)_35%,transparent)]", text: "text-[var(--chart-4)]" },
    { label: "Recent logs", value: stats.logs,    icon: ScrollText, hint: "last 100 requests", to: "/dashboard/logs",     accent: "bg-[color-mix(in_oklab,var(--chart-5)_14%,transparent)]", ring: "ring-[color-mix(in_oklab,var(--chart-5)_35%,transparent)]", text: "text-[var(--chart-5)]" },
  ];

  const quickActions: {
    label: string; desc: string; icon: typeof KeyRound;
    to: "/dashboard/tokens" | "/dashboard/rbac" | "/dashboard/realtime" | "/dashboard/sql" | "/dashboard/verify" | "/dashboard/backend-status";
  }[] = [
    { label: "Backend status", desc: "Live health, DB, migrations",         icon: Heart,       to: "/dashboard/backend-status" },
    { label: "Rotate keys",    desc: "Mint anon & service-role keys",       icon: KeyRound,    to: "/dashboard/tokens" },
    { label: "RLS & roles",    desc: "Edit policies and role registry",     icon: ShieldCheck, to: "/dashboard/rbac" },
    { label: "Realtime rooms", desc: "Inspect presence and broadcast",      icon: Radio,       to: "/dashboard/realtime" },
    { label: "SQL runner",     desc: "Run queries against Postgres",        icon: Terminal,    to: "/dashboard/sql" },
    { label: "Smoke tests",    desc: "One-click end-to-end verification",   icon: Activity,    to: "/dashboard/verify" },
  ];

  const healthAllOk = health.live && health.ready && health.mig;
  const healthAnyDown = health.live === false || health.ready === false || health.mig === false;
  const healthLabel = healthAllOk ? "All systems operational" : healthAnyDown ? "One or more checks failing" : "Probing backend…";

  return (
    <div>
      {/* Hero banner — gradient built from theme tokens, no hardcoded colors */}
      <section
        aria-label="Dashboard summary"
        className="relative mb-6 overflow-hidden rounded-xl border border-border bg-card"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-90"
          style={{
            background:
              "radial-gradient(circle at 12% 0%, color-mix(in oklab, var(--primary) 22%, transparent), transparent 55%), radial-gradient(circle at 100% 100%, color-mix(in oklab, var(--chart-2) 18%, transparent), transparent 60%)",
          }}
        />
        <div className="relative flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/70 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground backdrop-blur">
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${source === "live" ? "bg-emerald-500 shadow-[0_0_8px_theme(colors.emerald.500)]" : "bg-muted-foreground/60"}`}
                />
                {source === "live" ? "Live data" : "Mock data"} · Pluto instance
              </div>
              <a
                href={API_BASE}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/70 px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground backdrop-blur hover:text-foreground"
              >
                API · {API_BASE.replace(/^https?:\/\//, "")}
              </a>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
              স্বাগতম <span className="text-muted-foreground">— এক নজরে আপনার backend</span>
            </h1>
            <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
              Users, tables, storage buckets এবং সাম্প্রতিক request logs — সব এক স্ক্রিনে। যেকোনো কার্ডে ক্লিক করে detail ভিউতে যান।
            </p>
          </div>
          <div className="flex flex-shrink-0 flex-wrap gap-2">
            <Link
              to="/dashboard/verify"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Waves className="h-3.5 w-3.5" aria-hidden="true" /> Run smoke tests
            </Link>
            <Link
              to="/dashboard/sql"
              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background/70 px-3.5 py-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Terminal className="h-3.5 w-3.5" aria-hidden="true" /> Open SQL
            </Link>
          </div>
        </div>
      </section>

      {/* Live backend health strip — probes api.timescard.cloud every 30s */}
      <Link
        to="/dashboard/backend-status"
        aria-label="Open backend status page"
        className={`mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 transition hover:shadow-sm ${
          healthAllOk
            ? "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/50"
            : healthAnyDown
            ? "border-rose-500/30 bg-rose-500/5 hover:border-rose-500/50"
            : "border-border bg-card"
        }`}
      >
        <div className="flex items-center gap-2">
          {healthAllOk ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />
          ) : healthAnyDown ? (
            <XCircle className="h-5 w-5 text-rose-500" aria-hidden="true" />
          ) : (
            <Activity className="h-5 w-5 animate-pulse text-muted-foreground" aria-hidden="true" />
          )}
          <span className="text-sm font-medium text-foreground">{healthLabel}</span>
          {health.ms != null && <span className="text-xs text-muted-foreground">· {health.ms} ms</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {[
            { name: "/livez", ok: health.live },
            { name: "/readyz", ok: health.ready },
            { name: "/health/migrations", ok: health.mig },
          ].map((h) => (
            <span
              key={h.name}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono ${
                h.ok === true
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : h.ok === false
                  ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {h.ok === true ? "✓" : h.ok === false ? "✕" : "…"} {h.name}
            </span>
          ))}
          <span className="text-muted-foreground">→ details</span>
        </div>
      </Link>


      {activePlan && !dismissed && (
        <OnboardingWizard
          initialPlan={activePlan}
          onDismiss={() => {
            setDismissed(true);
            try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
            navigate({ to: "/dashboard", search: {} });
          }}
        />
      )}

      {err && (
        <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {err}
        </div>
      )}

      {/* Metric cards — color-coded by domain, click-through to detail routes */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(({ label, value, icon: Icon, hint, to, accent, ring, text }) => (
          <Link
            key={label}
            to={to}
            aria-label={`${label} — open ${label.toLowerCase()} page`}
            className={`group relative overflow-hidden rounded-xl border border-border bg-card p-5 transition hover:border-transparent hover:shadow-lg hover:ring-2 ${ring} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          >
            <div aria-hidden="true" className={`pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full blur-2xl ${accent}`} />
            <div className="relative flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
              <span className={`flex h-8 w-8 items-center justify-center rounded-md ${accent} ${text}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <div className="relative mt-4 flex items-baseline justify-between">
              <span className={`text-3xl font-semibold tracking-tight ${loaded ? "" : "animate-pulse text-muted-foreground/40"}`}>
                {loaded ? value.toLocaleString() : "—"}
              </span>
              <ArrowUpRight className="h-4 w-4 text-muted-foreground opacity-0 transition group-hover:opacity-100" aria-hidden="true" />
            </div>
            <div className="relative mt-1 text-xs text-muted-foreground">{hint}</div>
          </Link>
        ))}
      </div>

      {/* Quick actions */}
      <section aria-labelledby="quick-actions" className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="quick-actions" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Quick actions
          </h2>
          <Link
            to="/dashboard/projects"
            className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            All projects →
          </Link>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {quickActions.map(({ label, desc, icon: Icon, to }) => (
            <Link
              key={label}
              to={to}
              className="group rounded-lg border border-border bg-card p-4 transition hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
                <span className="text-sm font-medium">{label}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Connect snippet */}
      <section
        aria-labelledby="connect-heading"
        className="mt-8 overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-5 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 id="connect-heading" className="text-sm font-semibold">Connect your frontend</h2>
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">@pluto/js</span>
        </div>
        <div className="p-5">
          <p className="text-sm text-muted-foreground">
            নিচের snippet দিয়ে যেকোনো frontend (React / Vue / Svelte / vanilla JS) থেকে এই backend-এ connect করুন। Supabase-compatible surface — migration trivial।
          </p>
          <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-muted/30 p-4 font-mono text-xs leading-relaxed">
            <code>{`// npm i @pluto/js
import { createClient } from "@pluto/js";

const pluto = createClient(
  "${API_BASE}",
  "YOUR_PUBLISHABLE_KEY"  // Dashboard → Tokens
);

// Auth
const { data, error } = await pluto.auth.signInWithPassword({ email, password });

// Data API (PostgREST-compatible)
const { data: posts } = await pluto
  .from("posts")
  .select("id, title, created_at")
  .order("created_at", { ascending: false });

// Storage
await pluto.storage.from("avatars").upload("me.png", file);

// Realtime
pluto.channel("room-1").on("broadcast", { event: "msg" }, console.log).subscribe();`}</code>
          </pre>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Base URL config: <code className="rounded bg-muted px-1 py-0.5 font-mono">VITE_PLUTO_API_URL</code> env var (defaults to <code className="font-mono">https://api.timescard.cloud</code>).
          </p>
        </div>
      </section>
    </div>
  );
}
