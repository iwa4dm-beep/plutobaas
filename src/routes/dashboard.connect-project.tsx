import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  Check, Copy, Database, KeyRound, Loader2, Plug, Rocket,
  ShieldCheck, Terminal, Zap,
} from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { HelpPanel } from "@/components/help/HelpPanel";
import { dashboardConnectProjectHelp } from "@/content/help/dashboard.connect-project";
import { getApiBase } from "@/lib/pluto/base-url";

export const Route = createFileRoute("/dashboard/connect-project")({
  component: ConnectProjectPage,
});

type Step = {
  id: string;
  icon: typeof Plug;
  title_bn: string;
  title_en: string;
  body_bn: string;
  body_en: string;
  code?: { lang: string; content: string; caption_bn?: string; caption_en?: string }[];
};

const STEPS: Step[] = [
  {
    id: "prereq",
    icon: Check,
    title_bn: "১. পূর্বশর্ত যাচাই করুন",
    title_en: "1. Check prerequisites",
    body_bn: "শুরুর আগে নিশ্চিত করুন: PostgreSQL 14+ database (নিজের বা Pluto managed), Node.js 18+, একটি React/Vite project, এবং এই dashboard-এ workspace access।",
    body_en: "Before starting, confirm: PostgreSQL 14+ (own or Pluto-managed), Node.js 18+, a React/Vite project, and workspace access in this dashboard.",
  },
  {
    id: "workspace",
    icon: KeyRound,
    title_bn: "২. Workspace তৈরি ও API key সংগ্রহ",
    title_en: "2. Create a workspace and grab API keys",
    body_bn: "Sidebar → Platform → Workspaces খুলে একটি নতুন workspace তৈরি করুন। এরপর Projects & Keys পেইজ থেকে anon key এবং service_role key কপি করুন। anon key frontend-এ ব্যবহার হবে, service_role শুধু backend-এ।",
    body_en: "Open Sidebar → Platform → Workspaces and create a workspace. Then copy the anon key and service_role key from Projects & Keys. anon key goes in the frontend; service_role stays server-side only.",
  },
  {
    id: "db",
    icon: Database,
    title_bn: "৩. Database migrate ও schema import",
    title_en: "3. Migrate the database / import schema",
    body_bn: "যদি existing Postgres থাকে (BYOD), pg_dump দিয়ে schema export করে Pluto DB-তে restore করুন। এরপর Pluto migrations চালান যা `auth`, `storage`, `realtime` schema তৈরি করবে। প্রতিটি user-facing table-এ RLS enable করতে ভুলবেন না।",
    body_en: "If you already have a Postgres DB (BYOD), pg_dump the schema and restore into the Pluto DB. Then run Pluto migrations to create the `auth`, `storage`, and `realtime` schemas. Enable RLS on every user-facing table.",
    code: [
      {
        lang: "bash",
        caption_bn: "Existing schema export ও restore",
        caption_en: "Export & restore existing schema",
        content: `# 1) Export from your existing DB
pg_dump --schema-only --no-owner \\
  postgresql://user:pass@old-host/mydb > schema.sql

# 2) Restore into the Pluto-managed DB
psql "$PLUTO_DATABASE_URL" < schema.sql

# 3) Run Pluto core migrations (auth, storage, realtime, etc.)
pnpm --filter api migrate`,
      },
      {
        lang: "sql",
        caption_bn: "প্রতিটি table-এ RLS enable করুন",
        caption_en: "Enable RLS on each table",
        content: `alter table public.todos enable row level security;

create policy "owner can read"
  on public.todos for select
  using (auth.uid() = user_id);

create policy "owner can write"
  on public.todos for insert
  with check (auth.uid() = user_id);`,
      },
    ],
  },
  {
    id: "sdk",
    icon: Terminal,
    title_bn: "৪. Frontend-এ SDK install করুন",
    title_en: "4. Install the SDK in your frontend",
    body_bn: "আপনার React/Vite project-এ @pluto/js প্যাকেজ যোগ করুন এবং `.env`-এ API URL ও anon key রাখুন।",
    body_en: "Add the @pluto/js package to your React/Vite project and put the API URL and anon key in `.env`.",
    code: [
      {
        lang: "bash",
        caption_bn: "প্যাকেজ install করুন",
        caption_en: "Install the package",
        content: `bun add @pluto/js
# or: npm install @pluto/js`,
      },
      {
        lang: "env",
        caption_bn: ".env ফাইলে রাখুন",
        caption_en: "Add to your .env",
        content: `VITE_PLUTO_URL=__API_BASE__
VITE_PLUTO_ANON_KEY=pk_anon_xxxxxxxxxxxx`,
      },
    ],
  },
  {
    id: "client",
    icon: Plug,
    title_bn: "৫. Pluto client initialize করুন",
    title_en: "5. Initialize the Pluto client",
    body_bn: "`src/lib/pluto.ts` নামে একটি ফাইল তৈরি করে সেখানে single client instance রাখুন। এই client-ই সব feature-এ ব্যবহার হবে।",
    body_en: "Create `src/lib/pluto.ts` and export a single client instance. Every feature reuses this client.",
    code: [
      {
        lang: "ts",
        caption_bn: "src/lib/pluto.ts",
        caption_en: "src/lib/pluto.ts",
        content: `import { createClient } from "@pluto/js";

const url = import.meta.env.VITE_PLUTO_URL as string;
const anonKey = import.meta.env.VITE_PLUTO_ANON_KEY as string;

if (!url || !anonKey) {
  throw new Error("Missing VITE_PLUTO_URL / VITE_PLUTO_ANON_KEY");
}

export const pluto = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "pluto.auth.token",
  },
});`,
      },
    ],
  },
  {
    id: "auth",
    icon: ShieldCheck,
    title_bn: "৬. Auth (Sign up / Sign in) wire করুন",
    title_en: "6. Wire Auth (sign up / sign in)",
    body_bn: "Email/password এবং OAuth (Google, GitHub) দুইটাই সমর্থিত। Session automatic refresh হবে।",
    body_en: "Both email/password and OAuth (Google, GitHub) work out of the box; sessions auto-refresh.",
    code: [
      {
        lang: "ts",
        content: `// Sign up
await pluto.auth.signUp({ email, password });

// Sign in
await pluto.auth.signInWithPassword({ email, password });

// OAuth
await pluto.auth.signInWithOAuth({ provider: "google" });

// Listen to session
pluto.auth.onAuthStateChange((event, session) => {
  console.log(event, session);
});`,
      },
    ],
  },
  {
    id: "db-query",
    icon: Database,
    title_bn: "৭. Database (REST + GraphQL) query",
    title_en: "7. Query the database (REST + GraphQL)",
    body_bn: "PostgREST-compatible API এবং GraphQL — দুইটাই ব্যবহার করা যায়। RLS backend-এ enforce হবে।",
    body_en: "PostgREST-compatible REST plus GraphQL — both work. RLS is enforced on the backend.",
    code: [
      {
        lang: "ts",
        content: `// SELECT
const { data, error } = await pluto
  .from("todos")
  .select("id, title, done")
  .eq("user_id", user.id)
  .order("created_at", { ascending: false });

// INSERT
await pluto.from("todos").insert({ title: "Buy milk" });

// UPDATE
await pluto.from("todos").update({ done: true }).eq("id", id);

// DELETE
await pluto.from("todos").delete().eq("id", id);`,
      },
    ],
  },
  {
    id: "realtime",
    icon: Zap,
    title_bn: "৮. Realtime subscription",
    title_en: "8. Realtime subscriptions",
    body_bn: "Postgres CDC-এর মাধ্যমে row-level INSERT/UPDATE/DELETE event পাবেন। Presence-ও সমর্থিত।",
    body_en: "Row-level INSERT/UPDATE/DELETE events via Postgres CDC. Presence is also supported.",
    code: [
      {
        lang: "ts",
        content: `const channel = pluto
  .channel("todos-changes")
  .on("postgres_changes",
    { event: "*", schema: "public", table: "todos" },
    (payload) => console.log("change", payload)
  )
  .subscribe();

// cleanup
return () => { pluto.removeChannel(channel); };`,
      },
    ],
  },
  {
    id: "storage",
    icon: Database,
    title_bn: "৯. Storage — file upload/download",
    title_en: "9. Storage — file upload/download",
    body_bn: "Bucket তৈরি করে file upload করুন। Public bucket থেকে সরাসরি URL, private bucket-এ signed URL।",
    body_en: "Create a bucket, then upload files. Public buckets serve direct URLs; private buckets use signed URLs.",
    code: [
      {
        lang: "ts",
        content: `// Upload
await pluto.storage
  .from("avatars")
  .upload(\`user-\${user.id}.png\`, file);

// Public URL
const { data } = pluto.storage.from("avatars").getPublicUrl("user-1.png");

// Signed URL (private)
const { data: signed } = await pluto.storage
  .from("docs")
  .createSignedUrl("private.pdf", 3600);`,
      },
    ],
  },
  {
    id: "functions",
    icon: Rocket,
    title_bn: "১০. Edge Functions invoke",
    title_en: "10. Invoke Edge Functions",
    body_bn: "Dashboard → Functions থেকে function deploy করুন, তারপর frontend থেকে invoke করুন।",
    body_en: "Deploy from Dashboard → Functions, then invoke from the frontend.",
    code: [
      {
        lang: "ts",
        content: `const { data, error } = await pluto.functions.invoke("send-email", {
  body: { to: "user@example.com", subject: "Hi" },
});`,
      },
    ],
  },
  {
    id: "verify",
    icon: Check,
    title_bn: "১১. Connection যাচাই",
    title_en: "11. Verify the connection",
    body_bn: "নিচের 'Test connection' বাটন চাপুন — এটি আপনার backend-এর /v1/health endpoint ping করে সব module-এর status দেখাবে।",
    body_en: "Click the 'Test connection' button below — it pings the backend `/v1/health` endpoint and reports every module's status.",
  },
  {
    id: "deploy",
    icon: Rocket,
    title_bn: "১২. Production-এ deploy",
    title_en: "12. Deploy to production",
    body_bn: "Production domain-কে CORS whitelist-এ যোগ করুন, API key rotate করুন, custom domain configure করুন, এবং Observability + Backups on রাখুন।",
    body_en: "Add the production domain to the CORS whitelist, rotate API keys, configure a custom domain, and enable Observability + Backups.",
  },
];

function CodeBlock({ lang, content, caption }: { lang: string; content: string; caption?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="mt-3 rounded-md border border-border/60 bg-muted/40 overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/60 px-3 py-1.5 text-[11px]">
        <span className="font-mono uppercase tracking-wider text-muted-foreground">
          {lang}{caption ? ` · ${caption}` : ""}
        </span>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed font-mono text-foreground/90 whitespace-pre">
{content}
      </pre>
    </div>
  );
}

const PROGRESS_KEY = "pluto.connectProject.progress";

function ConnectProjectPage() {
  const apiBase = getApiBase();
  const [done, setDone] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      if (raw) setDone(new Set(JSON.parse(raw)));
    } catch { /* ignore */ }
  }, []);

  const toggle = useCallback((id: string) => {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(PROGRESS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch(`${apiBase}/v1/health`, { method: "GET" });
      const text = await r.text();
      setTestResult({ ok: r.ok, text: `HTTP ${r.status} — ${text.slice(0, 400)}` });
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }, [apiBase]);

  const completed = done.size;
  const total = STEPS.length;
  const pct = Math.round((completed / total) * 100);

  return (
    <div>
      <PageHeader
        eyebrow="Getting Started"
        title="Connect your project · নিজের প্রজেক্ট যুক্ত করুন"
        description="আপনার existing PostgreSQL + React/Vite project-কে Pluto BaaS-এ pipeline করার সম্পূর্ণ ধাপে ধাপে গাইড।"
        actions={
          <div className="flex items-center gap-3">
            <div className="text-xs text-muted-foreground">
              {completed}/{total} · {pct}%
            </div>
            <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        }
      />

      <HelpPanel help={dashboardConnectProjectHelp} defaultOpen={false} />

      {/* Quick links */}
      <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Link to="/dashboard/workspaces" className="rounded-md border border-border/60 bg-card/60 px-3 py-2 text-xs hover:bg-accent transition">Workspaces</Link>
        <Link to="/dashboard/projects" className="rounded-md border border-border/60 bg-card/60 px-3 py-2 text-xs hover:bg-accent transition">Projects &amp; Keys</Link>
        <Link to="/dashboard/cors" className="rounded-md border border-border/60 bg-card/60 px-3 py-2 text-xs hover:bg-accent transition">CORS whitelist</Link>
        <Link to="/dashboard/custom-domains" className="rounded-md border border-border/60 bg-card/60 px-3 py-2 text-xs hover:bg-accent transition">Custom domains</Link>
      </div>

      {/* Steps */}
      <ol className="space-y-4">
        {STEPS.map((step, idx) => {
          const Icon = step.icon;
          const isDone = done.has(step.id);
          return (
            <li
              key={step.id}
              className={`rounded-lg border p-5 transition ${
                isDone ? "border-primary/40 bg-primary/5" : "border-border/60 bg-card/60"
              }`}
            >
              <div className="flex items-start gap-4">
                <button
                  onClick={() => toggle(step.id)}
                  aria-label={isDone ? "Mark incomplete" : "Mark complete"}
                  className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition ${
                    isDone
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary"
                  }`}
                >
                  {isDone ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <h3 className="text-base font-semibold">{step.title_en}</h3>
                    <span className="text-sm text-muted-foreground">· {step.title_bn}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{step.body_en}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{step.body_bn}</p>

                  {step.code?.map((c, i) => (
                    <CodeBlock
                      key={i}
                      lang={c.lang}
                      content={c.content.replace("__API_BASE__", apiBase)}
                      caption={c.caption_en}
                    />
                  ))}

                  {step.id === "verify" && (
                    <div className="mt-3">
                      <button
                        onClick={runTest}
                        disabled={testing}
                        className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                      >
                        {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                        Test connection
                      </button>
                      {testResult && (
                        <div
                          className={`mt-3 rounded-md border p-3 text-xs ${
                            testResult.ok
                              ? "border-green-500/40 bg-green-500/5 text-green-700 dark:text-green-400"
                              : "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-400"
                          }`}
                        >
                          <div className="font-medium mb-1">
                            {testResult.ok ? "✓ Backend reachable" : "✗ Test failed"}
                          </div>
                          <pre className="whitespace-pre-wrap break-all font-mono">{testResult.text}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="hidden sm:block text-[11px] uppercase tracking-wider text-muted-foreground/60">
                  Step {idx + 1}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
