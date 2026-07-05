import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Copy, Check, Rocket, KeyRound, Database, Radio, ShieldCheck, Terminal, BookOpen } from "lucide-react";
import { AdminGate } from "@/components/AdminGate";

export const Route = createFileRoute("/docs/sdk")({
  head: () => ({
    meta: [
      { title: "SDK Integration Guide — Pluto BaaS" },
      { name: "description", content: "Step-by-step guide to connect any frontend (React, Vue, Svelte, Next.js, mobile) to the Pluto backend via @pluto/js." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ProtectedSdkGuide,
});

function ProtectedSdkGuide() {
  return (
    <AdminGate>
      <SdkGuide />
    </AdminGate>
  );
}

const API = (import.meta.env.VITE_PLUTO_API_URL as string) || "https://api.timescard.cloud";

function CodeBlock({ code, lang = "bash" }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="group relative overflow-hidden rounded-lg border border-border bg-muted/30">
      <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{lang}</span>
        <button onClick={copy} className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-background hover:text-foreground">
          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed"><code>{code}</code></pre>
    </div>
  );
}

function Step({ n, title, icon, children }: { n: number; title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-8 rounded-xl border border-border bg-card p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{n}</div>
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        </div>
      </div>
      <div className="ml-11 space-y-3 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

function SdkGuide() {
  return (
    <main className="mx-auto max-w-4xl p-6 md:p-10">
      <header className="mb-10 text-center">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          <BookOpen className="h-3.5 w-3.5" /> Pluto BaaS · Integration Guide
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground md:text-4xl">Connect any frontend in 5 minutes</h1>
        <p className="mx-auto mt-3 max-w-2xl text-base text-muted-foreground">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">@pluto/js</code> is a Supabase-compatible SDK. If you've used Supabase, the API surface is identical — swap the URL and key and you're done.
        </p>
        <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground">
          API base · <span className="text-foreground">{API}</span>
        </div>
      </header>

      <Step n={1} title="Install the SDK" icon={<Rocket className="h-5 w-5 text-primary" />}>
        <p>Works with any JavaScript / TypeScript project — React, Vue, Svelte, Next.js, React Native, or plain HTML.</p>
        <CodeBlock lang="bash" code={`npm i @pluto/js
# or
bun add @pluto/js
# or
pnpm add @pluto/js`} />
      </Step>

      <Step n={2} title="Get your publishable key" icon={<KeyRound className="h-5 w-5 text-primary" />}>
        <p>The publishable (anon) key is safe to ship in browser code — it's protected by Row-Level Security policies on the server.</p>
        <ol className="ml-4 list-decimal space-y-1 text-sm">
          <li>Open the Pluto dashboard → <b className="text-foreground">Tokens</b></li>
          <li>Copy the <b className="text-foreground">publishable</b> key (starts with <code className="rounded bg-muted px-1 font-mono text-xs">pk_...</code>)</li>
          <li>Never expose the <span className="text-rose-500">service-role</span> key in frontend code — it bypasses RLS</li>
        </ol>
      </Step>

      <Step n={3} title="Environment variables" icon={<Terminal className="h-5 w-5 text-primary" />}>
        <p>Add to your project's <code className="rounded bg-muted px-1 font-mono text-xs">.env.local</code> (Vite / Next.js / SvelteKit — prefix accordingly):</p>
        <CodeBlock lang=".env" code={`# Vite / React / Solid
VITE_PLUTO_API_URL=${API}
VITE_PLUTO_PUBLISHABLE_KEY=pk_your_key_here

# Next.js
NEXT_PUBLIC_PLUTO_API_URL=${API}
NEXT_PUBLIC_PLUTO_PUBLISHABLE_KEY=pk_your_key_here`} />
      </Step>

      <Step n={4} title="Initialize the client" icon={<Rocket className="h-5 w-5 text-primary" />}>
        <p>Create one shared client instance and import it wherever you need it.</p>
        <CodeBlock lang="ts" code={`// src/lib/pluto.ts
import { createClient } from "@pluto/js";

export const pluto = createClient(
  import.meta.env.VITE_PLUTO_API_URL,
  import.meta.env.VITE_PLUTO_PUBLISHABLE_KEY
);`} />
      </Step>

      <Step n={5} title="Authentication" icon={<ShieldCheck className="h-5 w-5 text-primary" />}>
        <p>Full auth flows — email/password, magic link, phone OTP, password reset, email confirmation.</p>
        <CodeBlock lang="ts" code={`// Sign up
const { data, error } = await pluto.auth.signUp({
  email: "user@example.com",
  password: "secret123",
});

// Sign in
await pluto.auth.signInWithPassword({ email, password });

// Get current session
const { data: { session } } = await pluto.auth.getSession();

// Listen to auth changes
pluto.auth.onAuthStateChange((event, session) => {
  console.log(event, session);
});

// Sign out
await pluto.auth.signOut();

// Password reset
await pluto.auth.resetPasswordForEmail(email, {
  redirectTo: \`\${window.location.origin}/reset-password\`,
});`} />
      </Step>

      <Step n={6} title="Database queries" icon={<Database className="h-5 w-5 text-primary" />}>
        <p>PostgREST-compatible query builder — select, filter, insert, update, delete.</p>
        <CodeBlock lang="ts" code={`// Select with filters and ordering
const { data: posts } = await pluto
  .from("posts")
  .select("id, title, author:users(name)")
  .eq("published", true)
  .order("created_at", { ascending: false })
  .limit(20);

// Insert
const { data } = await pluto
  .from("posts")
  .insert({ title: "Hello", body: "World" })
  .select()
  .single();

// Update
await pluto.from("posts").update({ title: "New" }).eq("id", 42);

// Delete
await pluto.from("posts").delete().eq("id", 42);`} />
      </Step>

      <Step n={7} title="Storage (file uploads)" icon={<Database className="h-5 w-5 text-primary" />}>
        <p>Upload, download, list, delete — with signed URLs for private buckets.</p>
        <CodeBlock lang="ts" code={`// Upload
await pluto.storage.from("avatars").upload("me.png", file, {
  contentType: file.type,
  upsert: true,
});

// Public URL (public bucket)
const { data: { publicUrl } } = pluto.storage.from("avatars").getPublicUrl("me.png");

// Signed URL (private bucket, 1 hour)
const { data } = await pluto.storage.from("private").createSignedUrl("doc.pdf", 3600);

// Download
const { data: blob } = await pluto.storage.from("avatars").download("me.png");`} />
      </Step>

      <Step n={8} title="Realtime subscriptions" icon={<Radio className="h-5 w-5 text-primary" />}>
        <p>WebSocket-based channels for broadcast messages, presence, and Postgres change events.</p>
        <CodeBlock lang="ts" code={`// Broadcast — chat, notifications
const channel = pluto.channel("room-1")
  .on("broadcast", { event: "msg" }, ({ payload }) => console.log(payload))
  .subscribe();

await channel.send({ type: "broadcast", event: "msg", payload: { text: "hi" } });

// Presence — who's online
channel.on("presence", { event: "sync" }, () => {
  console.log(channel.presenceState());
});

// Postgres change data capture
pluto.channel("posts-changes")
  .on("postgres_changes", { event: "*", schema: "public", table: "posts" },
     (payload) => console.log(payload))
  .subscribe();`} />
      </Step>

      <Step n={9} title="Framework-specific patterns" icon={<Rocket className="h-5 w-5 text-primary" />}>
        <div className="space-y-4">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-foreground">React (hook)</h3>
            <CodeBlock lang="tsx" code={`import { useEffect, useState } from "react";
import { pluto } from "./lib/pluto";

export function useUser() {
  const [user, setUser] = useState(null);
  useEffect(() => {
    pluto.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: sub } = pluto.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);
  return user;
}`} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-foreground">Next.js App Router</h3>
            <CodeBlock lang="ts" code={`// Server Component — use server-side client with cookies
// Client Component — use the shared browser client above.
// Middleware — refresh session with pluto.auth.getSession() before render.`} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-foreground">React Native</h3>
            <CodeBlock lang="ts" code={`import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@pluto/js";

export const pluto = createClient(URL, KEY, {
  auth: { storage: AsyncStorage, detectSessionInUrl: false },
});`} />
          </div>
        </div>
      </Step>

      <Step n={10} title="Production checklist" icon={<ShieldCheck className="h-5 w-5 text-primary" />}>
        <ul className="ml-4 list-disc space-y-1">
          <li>Enable RLS on every table (dashboard → Database → Policies)</li>
          <li>Add CORS origins for your production domain (dashboard → CORS)</li>
          <li>Set up email templates + branded sender domain (dashboard → Auth settings)</li>
          <li>Rotate keys periodically (dashboard → Tokens)</li>
          <li>Monitor <a className="text-primary hover:underline" href="/dashboard/backend-status">/dashboard/backend-status</a> for backend health</li>
          <li>Subscribe to UptimeRobot alerts for your API URL</li>
        </ul>
      </Step>

      <div className="mt-10 rounded-xl border border-border bg-muted/30 p-6 text-center">
        <p className="text-sm text-muted-foreground">Stuck? Open the dashboard SQL runner and validate your query, or check the API docs.</p>
        <div className="mt-4 flex justify-center gap-3">
          <a href="/dashboard/backend-status" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent">Backend status</a>
          <a href="/docs/api" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">API reference</a>
        </div>
      </div>
    </main>
  );
}
