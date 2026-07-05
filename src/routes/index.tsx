import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity, ArrowRight, Boxes, Check, Cloud, Code2, Copy, Database,
  Files, Github, KeyRound, Layers, LineChart, Lock, Radio, Search,
  ShieldCheck, Sparkles, Terminal, Waves, Workflow, Zap, HelpCircle,
  ChevronDown,
} from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pluto BaaS — Self-hosted backend for React, Vue & mobile" },
      { name: "description", content: "Open-source Backend-as-a-Service: auth, auto REST + GraphQL, realtime, storage, vector search, jobs and edge functions. Deploy with Docker, Fly, Railway or Render." },
      { name: "keywords", content: "BaaS, backend, Firebase alternative, Supabase alternative, self-hosted, Postgres, RLS, realtime, edge functions" },
      { property: "og:title", content: "Pluto BaaS — Self-hosted Firebase/Supabase alternative" },
      { property: "og:description", content: "Production-grade Backend-as-a-Service. 8 canonical modules, typed SDK, admin dashboard, RLS, MFA — fully open." },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://backend-joy.lovable.app/" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Pluto BaaS — Self-hosted backend platform" },
      { name: "twitter:description", content: "Auth, REST, Realtime, Storage, Vector, Edge, Jobs — one docker compose away." },
    ],
    links: [{ rel: "canonical", href: "https://backend-joy.lovable.app/" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "Pluto BaaS",
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Linux, macOS, Windows (Docker)",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          description: "Open-source self-hosted Backend-as-a-Service with authentication, auto-generated REST + GraphQL, realtime, storage, vector search and edge functions.",
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqs.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        }),
      },
    ],
  }),
  component: Landing,
});

// ---------- data ------------------------------------------------------------

const modules = [
  { icon: ShieldCheck, tag: "auth",       title: "Authentication",      desc: "Email/password, magic link, phone OTP, OAuth (Google, GitHub), MFA (TOTP), SAML SSO. JWT + refresh, session revocation." },
  { icon: Database,    tag: "data-api",   title: "Auto REST + GraphQL", desc: "Instant CRUD endpoints from Postgres tables. Filters, ordering, pagination, RLS enforced per JWT claim." },
  { icon: Radio,       tag: "realtime",   title: "Realtime v5",         desc: "WebSocket subscriptions, presence, ordered broadcast, sharded rooms, backpressure policies." },
  { icon: Files,       tag: "storage",    title: "Storage v4",          desc: "Public/private buckets, signed URLs, resumable uploads. Local disk or S3-compatible (MinIO, R2, S3)." },
  { icon: Cloud,       tag: "edge",       title: "Edge Functions v7",   desc: "Deploy TypeScript handlers to isolates. KV, queues, secrets, cron triggers." },
  { icon: Search,      tag: "vector",     title: "Vector v3",           desc: "pgvector-backed HNSW indexes, hybrid rerank (linear/RRF), streaming embeddings." },
  { icon: Workflow,    tag: "jobs",       title: "Jobs & Workflows",    desc: "Durable multi-step workflows with step ledger, retries, side-effect idempotency." },
  { icon: LineChart,   tag: "obs",        title: "Observability v3",    desc: "Structured logs, request-id tracing, Prometheus metrics, per-tenant usage & quotas." },
];

const dashboardFeatures = [
  { icon: KeyRound,   title: "Projects & Keys",   desc: "Anon + service-role keys per workspace with copy-safe minting." },
  { icon: Lock,       title: "CORS whitelist",    desc: "Per-project allow-list — no wildcards in production." },
  { icon: Database,   title: "Database Studio",   desc: "Visual table editor, SQL runner, migrations timeline." },
  { icon: ShieldCheck,title: "RLS & RBAC",        desc: "Native Postgres RLS policies + role registry, tested end-to-end." },
  { icon: Boxes,      title: "User Management",   desc: "List users, revoke sessions, assign roles, manage MFA." },
  { icon: Activity,   title: "Health & Verify",   desc: "/readyz + one-click smoke run of every canonical endpoint." },
];

const deployTargets = [
  { name: "Docker Compose", tag: "local",       hint: "docker compose up -d" },
  { name: "Fly.io",         tag: "recommended", hint: "flyctl deploy" },
  { name: "Railway",        tag: "1-click",     hint: "railway.json ready" },
  { name: "Render",         tag: "1-click",     hint: "render.yaml ready" },
  { name: "Any VPS",        tag: "diy",         hint: "Caddy + systemd" },
];

const stats = [
  { value: "8",   label: "canonical modules" },
  { value: "60+", label: "phases shipped" },
  { value: "15+", label: "endpoint smoke tests" },
  { value: "4",   label: "official SDKs" },
];

const codeSamples = {
  auth: `import { createClient } from "@pluto/client";

const pluto = createClient({
  url: "https://api.yourapp.com",
  anonKey: import.meta.env.VITE_PLUTO_ANON_KEY,
});

// Email + password
await pluto.auth.signIn("ada@example.com", "hunter2");

// Magic link — passwordless
await pluto.auth.signInWithMagicLink("ada@example.com");

// OAuth
pluto.auth.signInWithOAuth("google");`,
  data: `// Instant CRUD — no backend code
const { data } = await pluto
  .from("posts")
  .select("id, title, author:users(name)")
  .eq("published", true)
  .order("created_at", { ascending: false })
  .limit(20);

// RLS enforces "posts.owner = auth.uid()" server-side
await pluto.from("posts").insert({ title: "Hello Pluto" });`,
  realtime: `// Subscribe to row changes
const channel = pluto.realtime
  .subscribeTable("public:messages", (change) => {
    console.log(change.eventType, change.new);
  });

// Broadcast + presence
channel.presence.track({ user_id: me.id, status: "typing" });
channel.send({ type: "cursor", x: 120, y: 80 });`,
};

type Tab = keyof typeof codeSamples;

const plans = [
  {
    name: "Self-Hosted",
    price: "Free",
    priceHint: "MIT licensed · forever",
    tagline: "Run Pluto on your own hardware or VPS.",
    cta: { label: "Start Self-Hosted setup", plan: "self-hosted" as const },
    highlight: false,
    features: [
      "All 8 canonical modules",
      "Unlimited projects & users",
      "Docker Compose stack (Postgres, MinIO, API, Dashboard)",
      "Community support · GitHub issues",
    ],
    deploy: "Docker · Any VPS · Kubernetes",
  },
  {
    name: "Cloud Starter",
    price: "$19",
    priceHint: "per project / month",
    tagline: "Managed Pluto with predictable pricing for prototypes and side-projects.",
    cta: { label: "Start free trial", plan: "starter" as const },
    highlight: true,
    features: [
      "10k monthly active users",
      "10 GB Postgres · 20 GB storage",
      "500k Edge Function invocations / mo",
      "Daily backups · 7-day PITR",
      "Fly.io or Railway 1-click deploy",
    ],
    deploy: "Fly.io · Railway (managed)",
  },
  {
    name: "Business",
    price: "$99",
    priceHint: "per project / month",
    tagline: "Production workloads with team seats, higher quotas and priority support.",
    cta: { label: "Set up Business plan", plan: "business" as const },
    highlight: false,
    features: [
      "100k monthly active users",
      "100 GB Postgres · 500 GB storage",
      "5M Edge Function invocations / mo",
      "Read replicas · point-in-time restore",
      "SAML SSO · audit log export",
      "Render / Fly / dedicated regions",
    ],
    deploy: "Render · Fly · dedicated infra",
  },
];


const faqs = [
  {
    q: "How does Pluto handle CORS?",
    a: "Every project has a strict allow-list managed in Dashboard → CORS. No wildcards in production. Preflight is served by the API, and disallowed origins are rejected before they hit any module. Add your published frontend origin (e.g. https://backend-joy.lovable.app) before going live.",
  },
  {
    q: "What is Row-Level Security (RLS) and how do I use it?",
    a: "Pluto uses native Postgres RLS. Every request sets a Postgres session with the JWT claims (sub, role, workspace_id), so policies like posts.owner = auth.uid() run server-side. The Dashboard ships a policy editor and end-to-end regression tests so bad policies are caught before deploy.",
  },
  {
    q: "How is realtime implemented?",
    a: "Realtime v5 is a WebSocket gateway with sharded rooms, presence, ordered broadcast and backpressure. It piggybacks on Postgres logical replication for row-change events (subscribeTable) and adds application-level channels for chat, cursors and presence.",
  },
  {
    q: "Is pricing per-project or per-workspace?",
    a: "Cloud plans are billed per project. A workspace can hold many projects, each on its own plan. Self-hosted is free forever regardless of workspace or project count.",
  },
  {
    q: "How do I deploy Pluto?",
    a: "Four common paths: (1) docker compose up -d locally; (2) flyctl deploy using the shipped deploy/fly.toml; (3) Railway 1-click via railway.json; (4) Render blueprint via render.yaml. All four boot the same image and pass /readyz before serving traffic.",
  },
  {
    q: "Can I migrate from Firebase or Supabase?",
    a: "Yes. The Data API mirrors PostgREST semantics, so Supabase-JS query patterns port directly. For Firebase, use the Pluto CLI import command to move Auth users and Firestore collections into Postgres tables.",
  },
];

// ---------- page ------------------------------------------------------------

function Landing() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">
        Skip to content
      </a>
      <Header />
      <main id="main">
        <Hero />
        <StatsBar />
        <ModulesSection />
        <CodeShowcase />
        <DashboardSection />
        <PricingSection />
        <DeploySection />
        <FAQSection />
        <CTASection />
      </main>
      <Footer />
    </div>
  );
}

// ---------- sections --------------------------------------------------------

function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground" aria-hidden="true">
            <Zap className="h-4 w-4" />
          </div>
          <span className="font-semibold tracking-tight">Pluto BaaS</span>
          <span className="ml-2 hidden rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground sm:inline">
            v0.3 · phase 62
          </span>
        </div>
        <nav aria-label="Primary" className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <a href="#modules" className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Modules</a>
          <a href="#code" className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">SDK</a>
          <a href="#dashboard" className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Dashboard</a>
          <a href="#pricing" className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Pricing</a>
          <a href="#faq" className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">FAQ</a>
          <Link to="/docs/api" className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Docs</Link>
        </nav>
        <div className="flex items-center gap-2">
          <Link
            to="/auth"
            className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline"
          >
            Sign in
          </Link>
          <Link
            to="/dashboard"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Dashboard <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="relative overflow-hidden border-b border-border">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_30%_-10%,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_60%),radial-gradient(circle_at_80%_10%,color-mix(in_oklab,var(--chart-2)_15%,transparent),transparent_55%)]" />
      <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground shadow-sm">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_theme(colors.emerald.500)]" />
            Production-ready · Auth · REST · Realtime · Storage · Vector · Edge · Jobs · Obs
          </div>
          <h1 id="hero-heading" className="mt-6 text-4xl font-semibold tracking-tight sm:text-6xl">
            The open-source backend<br />
            <span className="bg-gradient-to-r from-primary to-[color-mix(in_oklab,var(--primary)_40%,var(--chart-2))] bg-clip-text text-transparent">
              your frontend was waiting for.
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg">
            Pluto ships a complete Backend-as-a-Service — authentication, auto-generated APIs,
            realtime, storage, vector search and edge functions — behind a typed SDK and an
            admin dashboard. Run it on your laptop with <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">docker compose up</code>,
            or one-click deploy to Fly, Railway or Render.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to="/dashboard" className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Launch Admin Console <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
            <a href="#code" className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-input bg-background/60 px-5 py-2.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Code2 className="h-4 w-4" aria-hidden="true" /> View SDK
            </a>
            <a href="https://github.com" target="_blank" rel="noreferrer" aria-label="View source on GitHub (opens in a new tab)" className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-input bg-background/60 px-5 py-2.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Github className="h-4 w-4" aria-hidden="true" /> Source
            </a>
          </div>
        </div>

        <TerminalCard />
      </div>
    </section>
  );
}

type ModuleProbe = {
  name: string;
  path: string;
  status: "pending" | "up" | "down";
  code?: number;
  latency_ms?: number;
  error?: string;
  attempts?: number;
};

type ReadyState =
  | { kind: "loading" }
  | { kind: "ok"; uptime_s: number; version?: string }
  | { kind: "degraded"; uptime_s?: number }
  | { kind: "unreachable"; error: string };

const MODULE_PROBES: { name: string; path: string }[] = [
  { name: "core",     path: "/readyz" },
  { name: "auth",     path: "/auth/v1/health" },
  { name: "rest",     path: "/rest/v1/" },
  { name: "storage",  path: "/storage/v1/" },
  { name: "realtime", path: "/realtime/v1/" },
  { name: "edge",     path: "/functions/v1/" },
  { name: "jobs",     path: "/jobs/v1/" },
  { name: "admin",    path: "/admin/v1/stats" },
];

const REFRESH_OPTIONS: { label: string; value: number }[] = [
  { label: "off", value: 0 },
  { label: "15s", value: 15_000 },
  { label: "30s", value: 30_000 },
  { label: "60s", value: 60_000 },
];

// Per-request timeout in ms; retries add up to 2 extra attempts with backoff.
const PROBE_TIMEOUT_MS = 3_500;
const MAX_ATTEMPTS = 3;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
  });
}

async function probeOnce(url: string, path: string, signal: AbortSignal): Promise<{ ok: boolean; code?: number; latency_ms: number; error?: string }> {
  const t0 = performance.now();
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  signal.addEventListener("abort", onAbort);
  const timeout = setTimeout(() => inner.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}${path}`, {
      signal: inner.signal, method: "GET", headers: { accept: "application/json" },
    });
    return { ok: r.status < 500, code: r.status, latency_ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, latency_ms: Math.round(performance.now() - t0), error: (e as Error).message || "network error" };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

async function probeWithRetry(url: string, path: string, signal: AbortSignal): Promise<ModuleProbe> {
  let last: Awaited<ReturnType<typeof probeOnce>> = { ok: false, latency_ms: 0, error: "no attempt" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await probeOnce(url, path, signal);
    if (last.ok) return { name: "", path, status: "up", code: last.code, latency_ms: last.latency_ms, attempts: attempt };
    if (attempt < MAX_ATTEMPTS) {
      // Exponential backoff: 300ms, 900ms
      try { await sleep(300 * Math.pow(3, attempt - 1), signal); } catch { break; }
    }
  }
  return { name: "", path, status: "down", code: last.code, latency_ms: last.latency_ms, error: last.error, attempts: MAX_ATTEMPTS };
}

const HISTORY_MAX = 20;
const HISTORY_STORAGE_KEY = "pluto.terminal.history.v1";
type HistoryModule = { name: string; status: ModuleProbe["status"]; code?: number; latency_ms?: number; error?: string; attempts?: number };
type HistoryPoint = { ts: number; up: number; down: number; total: number; avg_latency_ms: number; modules: HistoryModule[] };

function loadHistory(): HistoryPoint[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((h): h is HistoryPoint =>
      h && typeof h.ts === "number" && Array.isArray(h.modules)
    ).slice(-HISTORY_MAX);
  } catch { return []; }
}

function saveHistory(h: HistoryPoint[]) {
  try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(h)); } catch { /* quota */ }
}

function TerminalCard() {
  const [copied, setCopied] = useState(false);
  const [ready, setReady] = useState<ReadyState>({ kind: "loading" });
  const [probes, setProbes] = useState<ModuleProbe[]>(MODULE_PROBES.map((m) => ({ ...m, status: "pending" as const })));
  const [ts, setTs] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [refreshMs, setRefreshMs] = useState<number>(0);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const cmd = "git clone pluto-baas && cd pluto-baas && docker compose up -d";
  const apiUrl = (import.meta.env.VITE_PLUTO_URL as string | undefined) ?? "http://localhost:3000";

  // Hydrate persisted history once
  useEffect(() => { setHistory(loadHistory()); }, []);

  // Probe run
  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    setReady({ kind: "loading" });
    setProbes(MODULE_PROBES.map((m) => ({ ...m, status: "pending" as const })));

    (async () => {
      const results = await Promise.all(
        MODULE_PROBES.map(async (m) => {
          const p = await probeWithRetry(apiUrl, m.path, ctrl.signal);
          return { ...p, name: m.name };
        })
      );
      if (cancelled) return;
      setProbes(results);
      const upList = results.filter((r) => r.status === "up");
      const point: HistoryPoint = {
        ts: Date.now(),
        up: upList.length,
        down: results.filter((r) => r.status === "down").length,
        total: results.length,
        avg_latency_ms: upList.length
          ? Math.round(upList.reduce((a, r) => a + (r.latency_ms ?? 0), 0) / upList.length)
          : 0,
        modules: results.map((r) => ({
          name: r.name, status: r.status,
          code: r.code, latency_ms: r.latency_ms, error: r.error, attempts: r.attempts,
        })),
      };
      setHistory((h) => {
        const next = [...h, point].slice(-HISTORY_MAX);
        saveHistory(next);
        return next;
      });

      const core = results[0];
      if (!core || core.status === "down") {
        setReady({ kind: "unreachable", error: core?.error ?? `HTTP ${core?.code}` });
      } else {
        try {
          const r = await fetch(`${apiUrl.replace(/\/$/, "")}/readyz`, { signal: ctrl.signal });
          const body = await r.json().catch(() => ({}));
          const allUp = results.every((x) => x.status === "up");
          setReady(
            r.ok && body.ok && allUp
              ? { kind: "ok", uptime_s: body.uptime_s ?? 0 }
              : { kind: "degraded", uptime_s: body.uptime_s }
          );
        } catch {
          setReady({ kind: "degraded" });
        }
      }
      setTs(new Date());
    })();

    return () => { cancelled = true; ctrl.abort(); };
  }, [apiUrl, nonce]);

  // Auto-refresh
  useEffect(() => {
    if (!refreshMs) return;
    const id = setInterval(() => setNonce((n) => n + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  // "last updated Xs ago" ticker
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  function copy() {
    void navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function exportSnapshot() {
    const snapshot = {
      generated_at: new Date().toISOString(),
      api_url: apiUrl,
      status: ready.kind,
      ...(ready.kind === "ok" || ready.kind === "degraded" ? { uptime_s: ready.kind === "ok" ? ready.uptime_s : ready.uptime_s } : {}),
      ...(ready.kind === "unreachable" ? { error: ready.error } : {}),
      modules: probes.map((p) => ({
        name: p.name,
        path: p.path,
        status: p.status,
        http_code: p.code ?? null,
        latency_ms: p.latency_ms ?? null,
        attempts: p.attempts ?? null,
        error: p.error ?? null,
      })),
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pluto-status-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    // Always quote every field; Excel/Sheets parse this most reliably.
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    // Stable, documented column order. Do not change without bumping consumers.
    const columns: { key: string; get: (p: ModuleProbe) => unknown }[] = [
      { key: "generated_at",   get: () => generated },
      { key: "api_url",        get: () => apiUrl },
      { key: "overall_status", get: () => ready.kind },
      { key: "module",         get: (p) => p.name },
      { key: "path",           get: (p) => p.path },
      { key: "status",         get: (p) => p.status },
      { key: "http_code",      get: (p) => p.code ?? "" },
      { key: "latency_ms",     get: (p) => p.latency_ms ?? "" },
      { key: "attempts",       get: (p) => p.attempts ?? "" },
      { key: "max_attempts",   get: () => MAX_ATTEMPTS },
      { key: "error",          get: (p) => p.error ?? "" },
    ];
    const generated = new Date().toISOString();
    // Sort probes in canonical MODULE_PROBES order so the sheet is deterministic.
    const byName = new Map(probes.map((p) => [p.name, p]));
    const ordered: ModuleProbe[] = MODULE_PROBES.map((m) =>
      byName.get(m.name) ?? { ...m, status: "pending" as const }
    );
    const headerRow = columns.map((c) => esc(c.key)).join(",");
    const rows = ordered.map((p) => columns.map((c) => esc(c.get(p))).join(","));
    // BOM ensures Excel opens as UTF-8; CRLF is the CSV RFC-recommended line ending.
    const csv = "\uFEFF" + [headerRow, ...rows].join("\r\n") + "\r\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pluto-status-${generated.replace(/[:.]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function clearHistory() {
    setHistory([]);
    try { localStorage.removeItem(HISTORY_STORAGE_KEY); } catch { /* ignore */ }
  }

  const headerColor =
    ready.kind === "ok" ? "text-primary" :
    ready.kind === "degraded" ? "text-amber-500" :
    ready.kind === "unreachable" ? "text-destructive" :
    "text-muted-foreground";

  const headerLabel =
    ready.kind === "ok" ? `✓ all systems operational · uptime ${ready.uptime_s}s` :
    ready.kind === "degraded" ? "⚠ degraded — some modules unreachable" :
    ready.kind === "unreachable" ? "✗ backend unreachable" :
    "→ probing modules...";

  const relTime = (() => {
    if (!ts) return "";
    void tick; // subscribe to 1s ticker
    const s = Math.max(0, Math.floor((Date.now() - ts.getTime()) / 1000));
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s ago`;
  })();

  return (
    <div className="mx-auto mt-14 max-w-3xl overflow-hidden rounded-xl border border-border bg-card/70 shadow-2xl shadow-primary/5 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2">
        <div className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-amber-500/60" />
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-emerald-500/60" />
          <span className="ml-3 text-xs text-muted-foreground">~ / pluto-quickstart</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-1">
            <span className="hidden sm:inline">auto</span>
            <select
              value={refreshMs}
              onChange={(e) => setRefreshMs(Number(e.target.value))}
              aria-label="Auto-refresh interval"
              className="rounded border border-border bg-background px-1.5 py-0.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            aria-label="Re-run module probes"
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            refresh
          </button>
          <button
            type="button"
            onClick={exportSnapshot}
            aria-label="Download status snapshot as JSON"
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            json
          </button>
          <button
            type="button"
            onClick={exportCsv}
            aria-label="Download status snapshot as CSV"
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            csv
          </button>
          {history.length > 0 && (
            <button
              type="button"
              onClick={clearHistory}
              aria-label="Clear persisted probe history"
              className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              clear history
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? "Command copied" : "Copy quickstart command"}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Copy className="h-3 w-3" aria-hidden="true" /> {copied ? "copied" : "copy"}
          </button>
        </div>
      </div>
      <pre aria-live="polite" aria-atomic="true" className="overflow-x-auto p-5 font-mono text-xs leading-relaxed sm:text-sm">
        <div><span className="text-emerald-500" aria-hidden="true">$</span> git clone pluto-baas && cd pluto-baas && docker compose up -d</div>
        <div className="mt-3 text-muted-foreground">
          <span className="text-emerald-500" aria-hidden="true">$</span> pluto status --url {apiUrl}
        </div>
        <div className={`mt-1 ${headerColor}`}>
          {headerLabel}
          {ts ? <span className="text-muted-foreground">  · updated {relTime}</span> : null}
        </div>

        {ready.kind === "unreachable" && (
          <div className="mt-1 text-muted-foreground">  set VITE_PLUTO_URL, or run `docker compose up -d`</div>
        )}

        {history.length >= 2 && <TrendChart history={history} />}



        <div className="mt-3 text-muted-foreground">module              status   latency   http   try</div>
        <div className="text-muted-foreground">──────              ──────   ───────   ────   ───</div>
        {probes.map((p) => {
          const color =
            p.status === "up"   ? "text-emerald-500" :
            p.status === "down" ? "text-destructive" :
            "text-muted-foreground";
          const glyph = p.status === "up" ? "✓" : p.status === "down" ? "✗" : "…";
          return (
            <div key={p.name} className={color}>
              {"  "}{glyph} {p.name.padEnd(18)}{" "}
              <span>{p.status.padEnd(8)}</span>
              <span className="text-muted-foreground">
                {typeof p.latency_ms === "number" ? `${p.latency_ms}ms`.padEnd(9) : "—        "}
                {(p.code ? String(p.code) : p.error ? "err" : "—").padEnd(6)}
                {p.attempts ? `${p.attempts}/${MAX_ATTEMPTS}` : ""}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function TrendChart({ history }: { history: HistoryPoint[] }) {
  const W = 320;
  const H = 56;
  const PAD_X = 4;
  const PAD_Y = 6;
  const n = history.length;
  const maxLat = Math.max(50, ...history.map((h) => h.avg_latency_ms));
  const total = history[history.length - 1]?.total ?? 1;

  const x = (i: number) => n === 1 ? W / 2 : PAD_X + (i * (W - PAD_X * 2)) / (n - 1);
  const yLat = (v: number) => H - PAD_Y - (v / maxLat) * (H - PAD_Y * 2);
  const yUp = (up: number) => H - PAD_Y - (up / total) * (H - PAD_Y * 2);

  const latPath = history.map((h, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yLat(h.avg_latency_ms).toFixed(1)}`).join(" ");
  const upPath = history.map((h, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yUp(h.up).toFixed(1)}`).join(" ");
  const latest = history[history.length - 1];

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>trend · last {n} probe{n === 1 ? "" : "s"}</span>
        <span>
          <span className="text-emerald-500">■</span> up {latest.up}/{latest.total}
          {"  "}
          <span className="text-primary">■</span> avg {latest.avg_latency_ms}ms (max {maxLat}ms)
        </span>
      </div>
      <svg
        role="img"
        aria-label={`Latency and uptime trend across the last ${n} refreshes. Current average latency ${latest.avg_latency_ms}ms, ${latest.up} of ${latest.total} modules up.`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-14 w-full rounded border border-border bg-muted/20"
      >
        <path d={upPath} fill="none" stroke="currentColor" strokeWidth="1.25" className="text-emerald-500 opacity-70" />
        <path d={latPath} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
        {history.map((h, i) => (
          <circle
            key={h.ts}
            cx={x(i)}
            cy={yLat(h.avg_latency_ms)}
            r={i === n - 1 ? 2.5 : 1.5}
            className={h.down > 0 ? "fill-destructive" : "fill-primary"}
          >
            <title>{`${new Date(h.ts).toLocaleTimeString()} — ${h.up}/${h.total} up · avg ${h.avg_latency_ms}ms`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}





function StatsBar() {
  return (
    <section aria-label="Platform stats" className="border-b border-border bg-muted/20">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-4 px-6 py-10 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="text-center">
            <div className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{s.value}</div>
            <div className="mt-1 text-xs uppercase tracking-wider text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ModulesSection() {
  return (
    <section id="modules" aria-labelledby="modules-heading" className="border-b border-border">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <SectionHeading
          eyebrow="Core modules"
          id="modules-heading"
          title="Everything your app needs, already wired."
          subtitle="Eight canonical services, all namespaced, all versioned, all covered by integration tests."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {modules.map(({ icon: Icon, tag, title, desc }) => (
            <article key={tag} className="group relative overflow-hidden rounded-lg border border-border bg-card p-5 transition hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5">
              <div className="flex items-center justify-between">
                <div aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </div>
                <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">/{tag}</span>
              </div>
              <h3 className="mt-4 font-medium">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{desc}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function CodeShowcase() {
  const [tab, setTab] = useState<Tab>("auth");
  const tabs: { id: Tab; label: string; icon: typeof ShieldCheck }[] = [
    { id: "auth",     label: "Authentication", icon: ShieldCheck },
    { id: "data",     label: "Query data",     icon: Database },
    { id: "realtime", label: "Realtime",       icon: Radio },
  ];
  return (
    <section id="code" aria-labelledby="code-heading" className="border-b border-border bg-muted/10">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <SectionHeading
          eyebrow="Typed SDK"
          id="code-heading"
          title={<>Two lines of setup. <span className="text-muted-foreground">Then you're shipping.</span></>}
          subtitle="One @pluto/client works from React, Vue, React Native and Node — plus first-party Python and Go SDKs."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-[220px_1fr]">
          <div role="tablist" aria-label="SDK examples" className="flex flex-row gap-2 lg:flex-col">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                role="tab"
                type="button"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
                className={`flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  tab === id
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border bg-card text-muted-foreground hover:border-border hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" /> {label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            className="overflow-hidden rounded-xl border border-border bg-card"
          >
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
              <span className="font-mono">app.ts</span>
              <span>@pluto/client</span>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-xs leading-relaxed sm:text-sm">
              <code>{codeSamples[tab]}</code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function DashboardSection() {
  return (
    <section id="dashboard" aria-labelledby="dashboard-heading" className="border-b border-border">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <SectionHeading
          eyebrow="Admin dashboard"
          id="dashboard-heading"
          title="A control panel, not just a placeholder."
          subtitle="Every module has a real UI. Manage keys, whitelist origins, edit schemas, revoke sessions — without touching SQL."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {dashboardFeatures.map(({ icon: Icon, title, desc }) => (
            <article key={title} className="rounded-lg border border-border bg-card p-5">
              <div aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <Icon className="h-4 w-4" />
              </div>
              <h3 className="mt-4 font-medium">{title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{desc}</p>
            </article>
          ))}
        </div>
        <div className="mt-8 flex justify-center">
          <Link to="/dashboard" className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-input px-4 py-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Explore the dashboard <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}

function PricingSection() {
  return (
    <section id="pricing" aria-labelledby="pricing-heading" className="border-b border-border bg-muted/10">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <SectionHeading
          eyebrow="Pricing"
          id="pricing-heading"
          title="Free to self-host. Fair when you scale."
          subtitle="Pluto is MIT-licensed and free forever on your own hardware. Managed cloud plans are per-project — no per-seat surprises."
        />
        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {plans.map((p) => (
            <article
              key={p.name}
              aria-labelledby={`plan-${p.name.replace(/\s/g, "-")}`}
              className={`relative flex flex-col rounded-xl border p-6 ${
                p.highlight
                  ? "border-primary/60 bg-card shadow-xl shadow-primary/10"
                  : "border-border bg-card"
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-6 rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">
                  Most popular
                </span>
              )}
              <h3 id={`plan-${p.name.replace(/\s/g, "-")}`} className="text-lg font-semibold">{p.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{p.tagline}</p>
              <div className="mt-5 flex items-baseline gap-1.5">
                <span className="text-4xl font-semibold tracking-tight">{p.price}</span>
                <span className="text-xs text-muted-foreground">{p.priceHint}</span>
              </div>
              <ul className="mt-6 space-y-2.5 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 flex-none text-primary" aria-hidden="true" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Deploy:</span> {p.deploy}
              </div>
              <Link
                to="/dashboard"
                search={{ plan: p.cta.plan } as never}
                className={`mt-6 inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-4 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  p.highlight
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border border-input hover:bg-accent"
                }`}
              >
                {p.cta.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </article>
          ))}
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          All cloud plans include TLS, daily backups, and access to the admin dashboard. Need on-premise or enterprise SLA? <Link to="/dashboard" className="underline hover:text-foreground">Talk to us</Link>.
        </p>
      </div>
    </section>
  );
}

function DeploySection() {
  return (
    <section id="deploy" aria-labelledby="deploy-heading" className="border-b border-border">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <SectionHeading
          eyebrow="Deploy anywhere"
          id="deploy-heading"
          title="Your infrastructure. Your data."
          subtitle="Config files ship with the repo — pick a target and go live in minutes."
        />
        <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {deployTargets.map((d) => (
            <article key={d.name} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <span className="font-medium">{d.name}</span>
                <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{d.tag}</span>
              </div>
              <div className="mt-3 font-mono text-xs text-muted-foreground">{d.hint}</div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function FAQSection() {
  return (
    <section id="faq" aria-labelledby="faq-heading" className="border-b border-border bg-muted/10">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <SectionHeading
          eyebrow="FAQ"
          id="faq-heading"
          title="Answers before you ask."
          subtitle="Common questions from teams evaluating Pluto against Firebase and Supabase."
        />
        <div className="mt-10 space-y-3">
          {faqs.map((f, i) => (
            <details
              key={f.q}
              className="group rounded-lg border border-border bg-card p-4 open:shadow-sm"
              {...(i === 0 ? { open: true } : {})}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="flex items-center gap-2">
                  <HelpCircle className="h-4 w-4 text-primary" aria-hidden="true" />
                  {f.q}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTASection() {
  return (
    <section aria-labelledby="cta-heading" className="border-b border-border">
      <div className="mx-auto max-w-4xl px-6 py-24 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          <Sparkles className="h-3 w-3 text-primary" aria-hidden="true" /> Ready when you are
        </div>
        <h2 id="cta-heading" className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">
          Stop stitching backends together.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
          Spin up Pluto, point your React app at it, and get back to building features your users care about.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link to="/dashboard" className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Open Dashboard <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Link to="/dashboard/sdk-demo" className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-input px-5 py-2.5 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Terminal className="h-4 w-4" aria-hidden="true" /> Try the SDK demo
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-background">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="flex items-center gap-2">
            <div aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Zap className="h-3.5 w-3.5" />
            </div>
            <span className="font-semibold">Pluto BaaS</span>
          </div>
          <p className="mt-3 max-w-xs text-xs text-muted-foreground">
            Open-source backend platform. Own the data, own the stack.
          </p>
        </div>

        <FooterCol title="Product" links={[
          ["Modules",   "#modules"],
          ["SDK",       "#code"],
          ["Dashboard", "/dashboard"],
          ["Pricing",   "#pricing"],
          ["Deploy",    "#deploy"],
        ]} />

        <FooterCol title="Resources" links={[
          ["API docs",       "/docs/api"],
          ["Status",         "/status"],
          ["SDK demo",       "/dashboard/sdk-demo"],
          ["Live checklist", "/dashboard/verify"],
          ["FAQ",            "#faq"],
        ]} />

        <FooterCol title="Platform" links={[
          ["Sign in",     "/auth"],
          ["Projects",    "/dashboard/projects"],
          ["CORS",        "/dashboard/cors"],
          ["Settings",    "/dashboard/settings"],
        ]} />
      </div>
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-5 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} Pluto BaaS · MIT licensed</span>
          <span className="flex items-center gap-3">
            <Layers className="h-3.5 w-3.5" aria-hidden="true" /> Wave 3 canonical stack · Phase 62
            <Waves className="ml-2 h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <nav aria-label={title}>
      <div className="text-xs font-semibold uppercase tracking-wider text-foreground">{title}</div>
      <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
        {links.map(([label, href]) => (
          <li key={label}>
            {href.startsWith("/") ? (
              <Link to={href} className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}</Link>
            ) : (
              <a href={href} className="rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{label}</a>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SectionHeading({
  eyebrow, title, subtitle, id,
}: { eyebrow: string; title: React.ReactNode; subtitle: string; id?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</div>
      <h2 id={id} className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
      <p className="mt-3 text-sm text-muted-foreground sm:text-base">{subtitle}</p>
    </div>
  );
}
