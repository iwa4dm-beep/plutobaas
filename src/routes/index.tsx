import { createFileRoute, Link } from "@tanstack/react-router";
import { Database, Files, KeyRound, ShieldCheck, Terminal, Zap } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Pluto BaaS — Open-source backend for your apps" },
      { name: "description", content: "Self-hosted Auth, auto-generated REST API, and Storage. One docker-compose away." },
    ],
  }),
  component: Landing,
});

const features = [
  { icon: ShieldCheck, title: "Authentication", desc: "Email + password, JWT, refresh tokens, password reset, email verification." },
  { icon: Database, title: "Auto REST API", desc: "যেকোনো Postgres table থেকে instantly REST endpoints — filters, ordering, RLS সহ।" },
  { icon: Files, title: "Storage", desc: "Public/private buckets, signed URLs। Local disk বা S3-compatible driver।" },
  { icon: KeyRound, title: "Row-Level Security", desc: "PostgreSQL native RLS policies; প্রতি request-এ JWT claim থেকে user context।" },
  { icon: Terminal, title: "CLI + SDK", desc: "@pluto/client SDK যেকোনো frontend-এ; pluto CLI দিয়ে migrations।" },
  { icon: Zap, title: "Local + Cloud", desc: "docker-compose up দিয়ে laptop-এ; VPS / AWS / GCP — যেকোনো জায়গায়।" },
];

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Zap className="h-4 w-4" />
            </div>
            <span className="font-semibold tracking-tight">Pluto BaaS</span>
          </div>
          <Link to="/dashboard" className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Open Dashboard
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-20">
        <section className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> MVP Core — Auth · REST · Storage
          </div>
          <h1 className="mt-6 text-4xl sm:text-5xl font-semibold tracking-tight">
            Self-hosted backend for any frontend.
          </h1>
          <p className="mt-5 text-lg text-muted-foreground">
            Pluto আপনাকে দেয় একটি পূর্ণাঙ্গ Backend-as-a-Service — Authentication, PostgreSQL-এর উপর auto-generated REST API, এবং Storage। আপনার নিজস্ব machine বা cloud-এ চালান।
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link to="/dashboard" className="inline-flex items-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              Launch Admin Console
            </Link>
            <a href="#features" className="inline-flex items-center rounded-md border border-input px-5 py-2.5 text-sm font-medium hover:bg-accent">
              Features
            </a>
          </div>

          <div className="mt-10 rounded-lg border border-border bg-card text-left p-4 font-mono text-xs text-muted-foreground">
            <span className="text-emerald-500">$</span> git clone pluto-baas &amp;&amp; cd pluto-baas<br />
            <span className="text-emerald-500">$</span> docker compose up -d<br />
            <span className="text-foreground">→ http://localhost:8000  (API)</span><br />
            <span className="text-foreground">→ http://localhost:3000  (Admin)</span>
          </div>
        </section>

        <section id="features" className="mt-24 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-lg border border-border bg-card p-5">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent">
                <Icon className="h-4 w-4" />
              </div>
              <h3 className="mt-4 font-medium">{title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{desc}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-border mt-20">
        <div className="max-w-6xl mx-auto px-6 py-6 text-xs text-muted-foreground flex justify-between">
          <span>© Pluto BaaS</span>
          <span>MVP Core — Phase 1</span>
        </div>
      </footer>
    </div>
  );
}
