import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Copy, Check, ExternalLink, Github, Zap } from "lucide-react";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/integrations/lovable-frontend")({
  head: () => ({
    meta: [
      { title: "Connect Lovable Frontend — Pluto BaaS" },
      {
        name: "description",
        content:
          "Step-by-step guide to connect a Lovable.dev frontend project (from GitHub) to this Pluto BaaS backend.",
      },
    ],
  }),
  component: LovableFrontendIntegrationPage,
});

const PLUTO_URL = "https://api.timescard.cloud";

function CopyBlock({ code, id }: { code: string; id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="rounded-md border border-border bg-muted/40 p-3 text-xs overflow-x-auto">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        aria-label={`copy ${id}`}
        className="absolute top-2 right-2 rounded border border-border bg-background p-1 hover:bg-muted"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-medium">
          {n}
        </div>
        <h3 className="font-semibold">{title}</h3>
      </div>
      <div className="space-y-3 text-sm text-muted-foreground [&_p]:leading-relaxed">
        {children}
      </div>
    </div>
  );
}

function LovableFrontendIntegrationPage() {
  const [scenario, setScenario] = useState<"1" | "2" | "3">("1");

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-primary">
          <Github className="h-4 w-4" />
          <span className="text-xs font-medium uppercase tracking-wider">Integration guide</span>
        </div>
        <h1 className="text-2xl font-bold">Connect Lovable.dev Frontend → Pluto BaaS</h1>
      <AutoHelpPanel slug={'dashboard.integrations.lovable-frontend'} title={'Connect Lovable.dev Frontend → Pluto BaaS'} description={''} />
        <p className="text-muted-foreground">
          Your Lovable.dev frontend project (from GitHub) can use this Pluto instance as its
          backend for auth, database, storage, and realtime.
        </p>
      </header>

      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" /> Your backend URL
        </h2>
        <CopyBlock id="url" code={PLUTO_URL} />
        <p className="text-xs text-muted-foreground mt-2">
          Grab your <code>anon</code> (publishable) key from{" "}
          <a href="/dashboard/tokens" className="underline">
            Dashboard → API Keys
          </a>{" "}
          and add your frontend origin under{" "}
          <a href="/dashboard/cors" className="underline">
            CORS
          </a>
          .
        </p>
      </div>

      <div className="flex gap-2 border-b border-border">
        {(
          [
            ["1", "No Cloud"],
            ["2", "Lovable Cloud enabled"],
            ["3", "Nothing configured"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setScenario(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
              scenario === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Scenario {id}: {label}
          </button>
        ))}
      </div>

      {scenario === "2" ? (
        <div className="space-y-4">
          <Step n={1} title="Decide: Hybrid or Full migration">
            <p>
              <strong>Hybrid (recommended):</strong> keep Lovable Cloud for existing auth/tables,
              add Pluto only for new features (realtime, vector, multi-tenant admin).
            </p>
            <p>
              <strong>Full migration:</strong> export Cloud data → import to Pluto → replace{" "}
              <code>supabase.*</code> calls with <code>pluto.*</code>.
            </p>
          </Step>
          <Step n={2} title="Install Pluto SDK alongside Supabase">
            <CopyBlock id="install" code="bun add @pluto/js" />
          </Step>
          <Step n={3} title="Add env vars (do not remove Supabase ones)">
            <CopyBlock
              id="env"
              code={`VITE_PLUTO_URL=${PLUTO_URL}\nVITE_PLUTO_ANON_KEY=pk_anon_xxxxxxxxxxxx`}
            />
          </Step>
          <Step n={4} title="Create src/lib/pluto.ts">
            <CopyBlock
              id="client"
              code={`import { createClient } from "@pluto/js";

export const pluto = createClient(
  import.meta.env.VITE_PLUTO_URL,
  import.meta.env.VITE_PLUTO_ANON_KEY,
);`}
            />
          </Step>
          <Step n={5} title="Add your frontend origin to CORS">
            <p>
              Open{" "}
              <a href="/dashboard/cors" className="underline">
                Dashboard → CORS
              </a>{" "}
              and add both preview + published URLs (e.g.{" "}
              <code>https://myapp.lovable.app</code>).
            </p>
          </Step>
        </div>
      ) : (
        <div className="space-y-4">
          <Step n={1} title="Copy your anon key + add CORS origin">
            <p>
              <a href="/dashboard/tokens" className="underline">
                Dashboard → API Keys
              </a>{" "}
              → copy <code>anon</code>. Then{" "}
              <a href="/dashboard/cors" className="underline">
                Dashboard → CORS
              </a>{" "}
              → add your Lovable preview + published URLs.
            </p>
          </Step>
          <Step n={2} title="Install the SDK in your Lovable project">
            <p>In the Lovable editor chat, say:</p>
            <CopyBlock id="install" code="bun add @pluto/js" />
          </Step>
          <Step n={3} title="Add env vars">
            <CopyBlock
              id="env"
              code={`VITE_PLUTO_URL=${PLUTO_URL}\nVITE_PLUTO_ANON_KEY=pk_anon_xxxxxxxxxxxx`}
            />
          </Step>
          <Step n={4} title="Create src/lib/pluto.ts">
            <CopyBlock
              id="client"
              code={`import { createClient } from "@pluto/js";

export const pluto = createClient(
  import.meta.env.VITE_PLUTO_URL,
  import.meta.env.VITE_PLUTO_ANON_KEY,
);`}
            />
          </Step>
          <Step n={5} title="Create a table + RLS policy">
            <CopyBlock
              id="sql"
              code={`CREATE TABLE public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  title text not null,
  created_at timestamptz default now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.posts TO authenticated;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own posts" ON public.posts FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());`}
            />
            <p>
              Run in{" "}
              <a href="/dashboard/sql" className="underline">
                Dashboard → SQL Editor
              </a>
              .
            </p>
          </Step>
          <Step n={6} title="Verify from the browser">
            <CopyBlock
              id="verify"
              code={`const { data, error } = await pluto.from("posts").select("*").limit(1);
console.log({ data, error });`}
            />
          </Step>
        </div>
      )}

      <div className="rounded-lg border border-border bg-muted/30 p-5">
        <h2 className="font-semibold mb-2">Ready-to-copy example files</h2>
        <ul className="text-sm space-y-1 text-muted-foreground">
          <li>
            <code>examples/lovable-frontend/pluto-client.ts</code> — SDK setup
          </li>
          <li>
            <code>examples/lovable-frontend/auth-example.tsx</code> — sign-in / sign-up
          </li>
          <li>
            <code>examples/lovable-frontend/data-example.tsx</code> — CRUD + realtime
          </li>
          <li>
            <code>examples/lovable-frontend/.env.example</code> — env template
          </li>
          <li>
            <code>docs/CONNECT-LOVABLE-FRONTEND.md</code> — full walkthrough
          </li>
        </ul>
        <a
          href="/docs/sdk"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-3"
        >
          Full SDK docs <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}
