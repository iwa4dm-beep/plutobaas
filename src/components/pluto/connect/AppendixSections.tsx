import { useState } from "react";
import { Check, Copy, Database, Radio, Code2, FileText, LifeBuoy, Play, Zap, ShieldCheck } from "lucide-react";
import {
  SqlToolbar, MigrationRunner, RealtimeVerifier, ConnectionTester, E2ETestRunner,
} from "./ConnectTools";
import { PermissionChecker } from "./PermissionChecker";
import { resolveApiUrl } from "@/lib/pluto/base-url";

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

function Section({
  icon: Icon,
  title_en,
  title_bn,
  intro_en,
  intro_bn,
  children,
}: {
  icon: typeof Database;
  title_en: string;
  title_bn: string;
  intro_en?: string;
  intro_bn?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border/60 bg-card/60 p-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h3 className="text-base font-semibold">{title_en}</h3>
            <span className="text-sm text-muted-foreground">· {title_bn}</span>
          </div>
          {intro_en && <p className="mt-1 text-sm text-muted-foreground">{intro_en}</p>}
          {intro_bn && <p className="mt-1 text-sm text-muted-foreground">{intro_bn}</p>}
          {children}
        </div>
      </div>
    </section>
  );
}

const SCHEMA_SQL = `-- ============================================================
-- Pluto BaaS — baseline schema for a new project
-- Run inside your Pluto-managed Postgres (or via pnpm --filter api migrate)
-- ============================================================

-- 1) auth schema is created by Pluto core migrations. Verify:
--    select 1 from information_schema.schemata where schema_name='auth';

-- 2) A profiles table 1:1 with auth.users
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

alter table public.profiles enable row level security;

create policy "profiles are readable by owner"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles are updatable by owner"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create profile row on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) Roles table (never store roles on profiles)
create type public.app_role as enum ('admin', 'moderator', 'user');

create table if not exists public.user_roles (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users(id) on delete cascade,
  role     public.app_role not null,
  unique (user_id, role)
);

grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create policy "users read own roles"
  on public.user_roles for select
  using (auth.uid() = user_id);

-- 4) Storage buckets (public + private example)
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true),
       ('docs',    'docs',    false)
on conflict (id) do nothing;

create policy "avatars are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "users upload their own avatar"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "users read own docs"
  on storage.objects for select
  using (bucket_id = 'docs' and auth.uid()::text = (storage.foldername(name))[1]);

-- 5) Realtime — enable CDC broadcast on a table
select public.pluto_enable_realtime('public.profiles');

-- 6) Backups — Pluto runs nightly logical backups automatically.
--    To take a manual snapshot immediately:
--    select public.pluto_take_backup('manual-' || now()::text);`;

const REALTIME_CFG = `# ------------------------------------------------------------
# WebSocket endpoint (auto-derived from VITE_PLUTO_URL)
#   https://api.example.com  ->  wss://api.example.com/v1/realtime
#   http://localhost:8080    ->  ws://localhost:8080/v1/realtime
# ------------------------------------------------------------

# Optional: override the ws URL explicitly
VITE_PLUTO_REALTIME_URL=wss://api.example.com/v1/realtime

# Heartbeat + reconnect tuning (ms)
VITE_PLUTO_RT_HEARTBEAT=25000
VITE_PLUTO_RT_RECONNECT=2000`;

const REALTIME_CODE = `import { pluto } from "@/lib/pluto";

// 1) Postgres CDC — row-level changes on a table
const cdc = pluto
  .channel("todos-cdc")
  .on("postgres_changes",
    { event: "*", schema: "public", table: "todos", filter: \`user_id=eq.\${userId}\` },
    (payload) => console.log("row change", payload)
  )
  .subscribe((status) => console.log("cdc status", status));

// 2) Broadcast — ephemeral pub/sub (chat, cursors, typing)
const chat = pluto.channel("room:42");
chat.on("broadcast", { event: "message" }, ({ payload }) => console.log(payload));
chat.subscribe();
chat.send({ type: "broadcast", event: "message", payload: { text: "hi" } });

// 3) Presence — who is online?
const room = pluto.channel("presence:lobby", { config: { presence: { key: userId } } });
room.on("presence", { event: "sync" }, () => console.log(room.presenceState()));
room.subscribe(async (s) => {
  if (s === "SUBSCRIBED") await room.track({ user: userId, at: Date.now() });
});

// Cleanup
return () => { pluto.removeAllChannels(); };`;

const REACT_APP = `// src/App.tsx  — minimal end-to-end example
import { useEffect, useState } from "react";
import { pluto } from "@/lib/pluto";

type Todo = { id: string; title: string; done: boolean; user_id: string };

export default function App() {
  const [session, setSession] = useState(pluto.auth.getSession());
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState("");

  // 1) Listen to auth changes
  useEffect(() => {
    const { data: sub } = pluto.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // 2) Load + subscribe to realtime once signed in
  useEffect(() => {
    if (!session) return;
    pluto.from("todos").select("*").order("created_at", { ascending: false })
      .then(({ data }) => setTodos((data ?? []) as Todo[]));

    const ch = pluto
      .channel("todos-live")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "todos" },
        () => pluto.from("todos").select("*").then(({ data }) => setTodos((data ?? []) as Todo[]))
      )
      .subscribe();
    return () => { pluto.removeChannel(ch); };
  }, [session]);

  if (!session) {
    return (
      <button onClick={() => pluto.auth.signInWithOAuth({ provider: "google" })}>
        Sign in with Google
      </button>
    );
  }

  const add = async () => {
    if (!title.trim()) return;
    await pluto.from("todos").insert({ title, done: false, user_id: session.user.id });
    setTitle("");
  };

  return (
    <div>
      <p>Signed in as {session.user.email}</p>
      <input value={title} onChange={(e) => setTitle(e.target.value)} />
      <button onClick={add}>Add</button>
      <ul>
        {todos.map((t) => (
          <li key={t.id}>{t.title}{t.done ? " ✓" : ""}</li>
        ))}
      </ul>
      <button onClick={() => pluto.auth.signOut()}>Sign out</button>
    </div>
  );
}`;

const ENV_EXAMPLE = `# ============================================================
# .env.example — copy to .env.local and fill in
# ============================================================

# ---- API (frontend, safe to ship) ----
VITE_PLUTO_URL=https://api.example.com
VITE_PLUTO_ANON_KEY=pk_anon_replace_me

# ---- Auth ----
VITE_PLUTO_AUTH_REDIRECT=https://app.example.com/auth/callback
VITE_PLUTO_AUTH_STORAGE_KEY=pluto.auth.token

# ---- Realtime ----
# Optional — auto-derived from VITE_PLUTO_URL if omitted
VITE_PLUTO_REALTIME_URL=wss://api.example.com/v1/realtime
VITE_PLUTO_RT_HEARTBEAT=25000
VITE_PLUTO_RT_RECONNECT=2000

# ---- Storage ----
VITE_PLUTO_STORAGE_PUBLIC_BASE=https://api.example.com/v1/storage/public

# ============================================================
# SERVER-ONLY — never ship to the browser
# ============================================================
DATABASE_URL=postgresql://pluto:password@db.example.com:5432/pluto
PLUTO_SERVICE_KEY=sk_service_replace_me
PLUTO_JWT_SECRET=at_least_32_chars_random_string_replace_me

# S3-compatible object storage
S3_ENDPOINT=https://s3.example.com
S3_REGION=us-east-1
S3_ACCESS_KEY=replace_me
S3_SECRET_KEY=replace_me
S3_BUCKET=pluto

# SMTP for auth emails
SMTP_URL=smtp://user:pass@smtp.example.com:587`;

const TROUBLE: { code: string; en: string; bn: string; fix_en: string; fix_bn: string }[] = [
  {
    code: "CORS / Failed to fetch",
    en: "Browser blocks the request; console shows 'blocked by CORS policy' or a bare 'Failed to fetch'.",
    bn: "Browser request block করে; console-এ 'CORS policy' বা 'Failed to fetch' error দেখাচ্ছে।",
    fix_en: "Dashboard → Platform → CORS Origins-এ আপনার frontend origin (protocol + host + port) whitelist করুন। Localhost হলে http://localhost:5173 এবং production domain দুটোই যোগ করুন। Save-এর পর browser hard-reload করুন।",
    fix_bn: "Add your exact frontend origin (protocol + host + port) under Platform → CORS Origins. Include both http://localhost:5173 and the production domain. Hard-reload the browser after saving.",
  },
  {
    code: "401 Unauthorized / Invalid API key",
    en: "Backend responds with 401 or 'invalid_api_key'.",
    bn: "Backend 401 বা 'invalid_api_key' response দিচ্ছে।",
    fix_en: "VITE_PLUTO_ANON_KEY ঠিক আছে কিনা যাচাই করুন (pk_anon_... দিয়ে শুরু)। service_role key কখনো frontend-এ ব্যবহার করবেন না। Key rotate করলে Vite dev server restart করুন — env cached থাকে।",
    fix_bn: "Confirm VITE_PLUTO_ANON_KEY starts with pk_anon_ and matches the workspace. Never use service_role in the frontend. If you rotated the key, restart the Vite dev server — envs are cached.",
  },
  {
    code: "ECONNREFUSED / DNS / SSL error",
    en: "Test connection throws ECONNREFUSED, ENOTFOUND, or a TLS certificate error.",
    bn: "Test connection ECONNREFUSED, ENOTFOUND বা TLS certificate error দিচ্ছে।",
    fix_en: "VITE_PLUTO_URL-এ trailing slash নেই তা নিশ্চিত করুন। Local backend হলে http://localhost:8080 চলছে কিনা `curl $VITE_PLUTO_URL/v1/health` দিয়ে পরীক্ষা করুন। Production হলে DNS resolve হচ্ছে এবং TLS cert valid কিনা দেখুন।",
    fix_bn: "Ensure VITE_PLUTO_URL has no trailing slash. For local backends, verify http://localhost:8080 is running with `curl $VITE_PLUTO_URL/v1/health`. For production, confirm DNS resolves and the TLS cert is valid.",
  },
  {
    code: "RLS: new row violates row-level security policy",
    en: "Insert/update fails with 'new row violates row-level security policy'.",
    bn: "Insert/update-এ 'new row violates row-level security policy' error আসছে।",
    fix_en: "Insert payload-এ user_id = auth.uid() সেট আছে কিনা দেখুন। Policy-তে `with check (auth.uid() = user_id)` আছে কিনা যাচাই করুন। user_id column NOT NULL হওয়া উচিত।",
    fix_bn: "Ensure the insert payload sets user_id = auth.uid(). Check the policy uses `with check (auth.uid() = user_id)`. The user_id column should be NOT NULL.",
  },
  {
    code: "Realtime: CHANNEL_ERROR / stuck on 'joining'",
    en: "Subscribe callback never reaches 'SUBSCRIBED' or returns CHANNEL_ERROR.",
    bn: "Subscribe callback 'SUBSCRIBED' status-এ পৌঁছাচ্ছে না বা CHANNEL_ERROR দিচ্ছে।",
    fix_en: "Table-এ realtime enable আছে কিনা যাচাই করুন: `select public.pluto_enable_realtime('public.your_table');`. Firewall/proxy WebSocket upgrade allow করছে কিনা দেখুন। Filter syntax `column=eq.value` হতে হবে।",
    fix_bn: "Verify realtime is enabled: `select public.pluto_enable_realtime('public.your_table');`. Ensure your firewall/proxy allows WebSocket upgrades. Filter syntax must be `column=eq.value`.",
  },
  {
    code: "Migration failed / auth.uid() does not exist",
    en: "Migrations abort with 'function auth.uid() does not exist' or similar.",
    bn: "Migration abort হচ্ছে 'function auth.uid() does not exist' error দিয়ে।",
    fix_en: "Auth shim migrations আগে run করা প্রয়োজন। `pnpm --filter api migrate` চালান — এটি auth শিম প্রয়োগ করে তারপর অন্য migrations চালায়। Manual হলে `node packages/api/scripts/bootstrap-auth-shim.mjs` আগে run করুন।",
    fix_bn: "The auth shim must run first. Run `pnpm --filter api migrate` — it bootstraps the auth shim before applying migrations. Manually: run `node packages/api/scripts/bootstrap-auth-shim.mjs` first.",
  },
  {
    code: "Storage: mime type / size rejected",
    en: "Upload fails with 413 Payload Too Large or 'mime_type not allowed'.",
    bn: "Upload 413 বা 'mime_type not allowed' error দিচ্ছে।",
    fix_en: "Bucket-এর allowed_mime_types এবং file_size_limit বাড়ান (Storage → Buckets → Edit)। Bundle-wide max hard limit BODY_LIMIT_MB পরিবর্তনের জন্য backend restart লাগবে।",
    fix_bn: "Raise allowed_mime_types and file_size_limit on the bucket (Storage → Buckets → Edit). The global BODY_LIMIT_MB cap needs a backend restart to change.",
  },
];

export function AppendixSections() {
  const apiBase = resolveApiUrl();
  return (
    <div className="mt-10 space-y-6">
      <div className="border-t border-border/60 pt-6">
        <h2 className="text-lg font-semibold">Reference &amp; live tools · রেফারেন্স ও লাইভ টুল</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Schema, migrations, realtime verifier, connection tester, end-to-end flow, .env, troubleshooting — সব একসাথে।
        </p>
      </div>

      <Section
        icon={Database}
        title_en="A. Database schema & migrations"
        title_bn="ক. ডাটাবেস স্কিমা ও মাইগ্রেশন"
        intro_en="Baseline SQL for auth-linked profiles, roles (user_roles + has_role), storage buckets with RLS, realtime, and a sample todos table. Copy the whole file, download it, or apply it live from the dashboard below."
        intro_bn="auth-linked profiles, user_roles + has_role role system, RLS সহ storage buckets, realtime, এবং একটি sample todos table — সবকিছুর baseline SQL। Copy/download অথবা নিচের dashboard runner দিয়ে সরাসরি apply করুন।"
      >
        <CodeBlock lang="sql" caption="migrations/0001_project_baseline.sql" content={SCHEMA_SQL} />
        <SqlToolbar />
        <div className="mt-4">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Live migration runner · লাইভ মাইগ্রেশন রানার
          </div>
          <MigrationRunner apiBase={apiBase} />
        </div>
      </Section>

      <Section
        icon={Radio}
        title_en="B. Realtime setup (channels & WebSocket)"
        title_bn="খ. রিয়েলটাইম সেটআপ (চ্যানেল ও WebSocket)"
        intro_en="Three modes: Postgres CDC (row changes), Broadcast (pub/sub), and Presence (who's online). Use the verifier below to check WebSocket connectivity and confirm subscriptions to the expected channels."
        intro_bn="তিনটি মোড: Postgres CDC (row পরিবর্তন), Broadcast (pub/sub), এবং Presence (কে অনলাইনে)। WebSocket connectivity ও channel subscription যাচাই করতে নিচের verifier ব্যবহার করুন।"
      >
        <CodeBlock lang="env" caption="Realtime config" content={REALTIME_CFG} />
        <CodeBlock lang="ts" caption="Subscribe from the frontend" content={REALTIME_CODE} />
        <div className="mt-4">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Realtime verifier · WebSocket + channel check
          </div>
          <RealtimeVerifier apiBase={apiBase} />
        </div>
      </Section>

      <Section
        icon={Code2}
        title_en="C. Step-by-step React / Vite example"
        title_bn="গ. React/Vite ধাপে ধাপে উদাহরণ"
        intro_en="A complete todos app using the auto-selected apiBase, OAuth sign-in, RLS-scoped queries, and a live realtime subscription."
        intro_bn="auto-selected apiBase, OAuth sign-in, RLS-scoped query, এবং live realtime subscription সহ একটি সম্পূর্ণ todos app।"
      >
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Install SDK: <code className="font-mono">bun add @pluto/js</code></li>
          <li>Copy the <code className="font-mono">.env.example</code> below → fill VITE_PLUTO_URL &amp; VITE_PLUTO_ANON_KEY.</li>
          <li>Create <code className="font-mono">src/lib/pluto.ts</code> (see Step 5 above).</li>
          <li>Drop the App.tsx below in and run <code className="font-mono">bun dev</code>.</li>
        </ol>
        <CodeBlock lang="tsx" caption="src/App.tsx" content={REACT_APP} />
      </Section>

      <Section
        icon={Play}
        title_en="C1. 'Test connection' — real backend checks"
        title_bn="গ১. 'Test connection' — সত্যিকারের backend check"
        intro_en="Runs live checks against your selected apiBase: HTTP health, auth service, WebSocket upgrade, and storage buckets. Optionally paste your anon key to exercise authenticated endpoints."
        intro_bn="আপনার selected apiBase-এ live check চালায়: HTTP health, auth service, WebSocket upgrade, এবং storage buckets। Authenticated endpoint check-এর জন্য anon key দিন।"
      >
        <ConnectionTester apiBase={apiBase} />
      </Section>

      <Section
        icon={Zap}
        title_en="C2. End-to-end test flow"
        title_bn="গ২. End-to-end টেস্ট ফ্লো"
        intro_en="Verifies the full stack with real API calls: sign-in → upload → download → list backups → subscribe to realtime → insert a row and receive the event → cleanup."
        intro_bn="সত্যিকারের API call দিয়ে full stack যাচাই: sign-in → upload → download → backups list → realtime subscribe → row insert করে event receive → cleanup।"
      >
        <E2ETestRunner apiBase={apiBase} />
      </Section>

      <Section
        icon={ShieldCheck}
        title_en="C3. Permission check — RLS/policies for storage, auth, backups"
        title_bn="গ৩. পারমিশন চেক — storage/auth/backups টেবিলের RLS/policy"
        intro_en="Probes each (role × resource × action) combination and reports whether the call was allowed, blocked by RLS/policy (401/403/404/406), or hit a server error. Use this to spot which role is missing a policy for read/write/delete."
        intro_bn="প্রতিটি (role × resource × action)-এর জন্য probe চালিয়ে দেখায় কোনটা allowed, কোনটা RLS/policy দ্বারা blocked, আর কোথায় server error হচ্ছে। কোন role-এ পড়া/লেখা block হচ্ছে সহজেই ধরতে পারবেন।"
      >
        <PermissionChecker apiBase={apiBase} />
      </Section>

      <Section
        icon={FileText}
        title_en="D. .env.example (Postgres, auth, realtime, storage)"
        title_bn="ঘ. .env.example (Postgres, auth, realtime, storage)"
        intro_en="Copy to .env.local. VITE_* keys ship to the browser; everything below the divider is server-only."
        intro_bn=".env.local-এ কপি করুন। VITE_* browser-এ যায়; divider-এর নিচেরগুলো শুধু server-side।"
      >
        <CodeBlock lang="env" caption=".env.example" content={ENV_EXAMPLE} />
      </Section>

      <Section
        icon={LifeBuoy}
        title_en="E. Troubleshooting — 'Test connection' failed"
        title_bn="ঙ. সমস্যা সমাধান — 'Test connection' ব্যর্থ"
        intro_en="Match the error you see against the rows below. Each row lists the root cause and the exact fix."
        intro_bn="আপনার error-এর সাথে নিচের row মিলিয়ে দেখুন। প্রতিটিতে root cause এবং exact fix দেওয়া আছে।"
      >
        <div className="mt-3 space-y-3">
          {TROUBLE.map((t) => (
            <div key={t.code} className="rounded-md border border-border/60 bg-muted/30 p-3">
              <div className="font-mono text-xs font-semibold text-foreground">{t.code}</div>
              <p className="mt-1 text-xs text-muted-foreground">{t.en}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t.bn}</p>
              <div className="mt-2 border-t border-border/50 pt-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Fix</div>
                <p className="mt-1 text-xs">{t.fix_en}</p>
                <p className="mt-0.5 text-xs">{t.fix_bn}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
