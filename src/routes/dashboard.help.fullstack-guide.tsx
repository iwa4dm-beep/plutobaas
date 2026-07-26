import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";

export const Route = createFileRoute("/dashboard/help/fullstack-guide")({
  head: () => ({
    meta: [
      { title: "Fullstack E2E Guide — Pluto BaaS" },
      {
        name: "description",
        content:
          "Zero-to-production, phase-by-phase guide to connecting a fullstack app to Pluto BaaS: schema, RLS, auth, deploy, and ops.",
      },
      { property: "og:title", content: "Fullstack E2E Guide — Pluto BaaS" },
      {
        property: "og:description",
        content:
          "Every phase from workspace creation to production rollout, with verify + rollback steps.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: FullstackGuidePage,
});

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="relative group my-3">
      <button
        type="button"
        onClick={onCopy}
        className="absolute right-2 top-2 rounded-md border border-border bg-background/90 px-2 py-1 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground transition"
        aria-label="Copy code"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 text-xs leading-relaxed">
        <code data-lang={lang}>{code}</code>
      </pre>
    </div>
  );
}

function Section({
  n,
  title,
  goal,
  children,
}: {
  n: string;
  title: string;
  goal: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-3">
      <header className="flex items-baseline gap-3">
        <span className="text-xs font-mono text-muted-foreground">{n}</span>
        <h2 className="text-lg font-semibold">{title}</h2>
      </header>
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Goal:</span> {goal}
      </p>
      <div className="text-sm space-y-2">{children}</div>
    </section>
  );
}

function FullstackGuidePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Fullstack E2E Guide"
        description="একটি fullstack প্রজেক্ট Pluto BaaS-এর সাথে যুক্ত করার সম্পূর্ণ ধাপে ধাপে গাইড — schema, RLS, auth, deploy, ops সব এক জায়গায়।"
      />

      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <strong>Related tools:</strong>{" "}
        <code>/dashboard/projects</code>, <code>/dashboard/ops/migrations</code>,{" "}
        <code>/dashboard/ops/rls-debug</code>, <code>/dashboard/ops/explain</code>,{" "}
        <code>/dashboard/ops/jwt-inspect</code>, <code>/dashboard/ops/docker-check</code>,{" "}
        <code>/dashboard/rbac-debug</code>. পূর্ণ markdown copy:{" "}
        <code>docs/GUIDE-FULLSTACK-E2E.md</code>.
      </div>

      <Section n="Phase 0" title="Prerequisites" goal="VPS ও local dev environment ready রাখা।">
        <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
          <li>Ubuntu 22.04/24.04 VPS (≥ 2 vCPU / 4 GB RAM), root/sudo access।</li>
          <li>DNS: apex + wildcard A-record VPS IP-এ pointing।</li>
          <li>Local: <code>node ≥ 20</code>, <code>bun</code>, <code>git</code>, <code>docker</code>।</li>
        </ul>
        <CodeBlock lang="bash" code={`node -v && bun -v && docker --version && docker compose version
dig +short app.example.com`} />
      </Section>

      <Section n="Phase 1" title="Workspace + Project" goal="Dashboard-এ workspace ও প্রথম project তৈরি।">
        <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
          <li>Sign in → <code>/dashboard</code>।</li>
          <li>Workspaces → <em>Create workspace</em> → slug দিন।</li>
          <li>Projects &amp; Keys → <em>Create project</em>।</li>
        </ol>
      </Section>

      <Section n="Phase 2" title="API Keys (anon + service_role)" goal="Frontend ও server call-এর জন্য key mint করা।">
        <p className="text-muted-foreground">
          <strong>anon</strong> — publishable, codebase-safe (<code>VITE_PLUTO_ANON_KEY</code>)।{" "}
          <strong>service_role</strong> — secret, কখনো frontend-এ ship করবেন না।
        </p>
        <CodeBlock lang="bash" code={`curl -s https://api.timescard.cloud/v1/health -H "apikey: <anon>"`} />
        <p className="text-xs text-muted-foreground">
          Conflict এলে (<code>api_keys_project_name_idx</code>), key row-এ <em>Resolve</em> বাটন থেকে rename/revoke করুন।
        </p>
      </Section>

      <Section
        n="Phase 3"
        title="Database Schema — Migration + RLS + GRANT"
        goal="প্রত্যেক public table-এ CREATE → GRANT → ENABLE RLS → POLICY এই ক্রমে migration লেখা।"
      >
        <CodeBlock
          lang="sql"
          code={`create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null,
  body text,
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.notes to authenticated;
grant all on public.notes to service_role;

alter table public.notes enable row level security;

create policy notes_owner_all on public.notes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());`}
        />
        <p className="text-muted-foreground text-xs">
          Roles আলাদা <code>user_roles</code> table-এ + security-definer <code>has_role()</code> function ব্যবহার করুন — profile-এ role রাখবেন না (privilege escalation ঝুঁকি)।
        </p>
        <p className="text-muted-foreground">
          Verify: <code>/dashboard/ops/migrations</code> → Plan → Dry-run → Apply। RLS check:{" "}
          <code>/dashboard/ops/rls-debug</code>।
        </p>
      </Section>

      <Section n="Phase 4" title="Auth (Email/Password + JWT)" goal="Sign up/in flow ও JWT propagation।">
        <CodeBlock
          lang="ts"
          code={`import { createPlutoClient } from "@pluto/js";
export const pluto = createPlutoClient({
  url: import.meta.env.VITE_PLUTO_URL,
  anonKey: import.meta.env.VITE_PLUTO_ANON_KEY,
});
await pluto.auth.signInWithPassword({ email, password });`}
        />
        <p className="text-muted-foreground">
          JWT decode ও role verify: <code>/dashboard/ops/jwt-inspect</code>,{" "}
          <code>/dashboard/rbac-debug</code>।
        </p>
      </Section>

      <Section n="Phase 5" title="Frontend Wiring" goal="SDK install + runtime env inject।">
        <CodeBlock lang="bash" code={`bun add @pluto/js
bash pluto-backend/deploy/inject-pluto-env.sh`} />
        <CodeBlock lang="ts" code={`const { data, error } = await pluto
  .from("notes")
  .select("*")
  .order("created_at", { ascending: false });`} />
        <p className="text-muted-foreground text-xs">
          CORS error হলে <code>/dashboard/cors</code>-এ origin whitelist যোগ করুন।
        </p>
      </Section>

      <Section n="Phase 6" title="Storage + Realtime" goal="File upload + live subscription।">
        <CodeBlock
          lang="ts"
          code={`await pluto.storage.from("avatars").upload(\`\${userId}/pic.png\`, file);

pluto.channel("notes-changes")
  .on("postgres_changes",
      { event: "*", schema: "public", table: "notes" },
      (p) => console.log(p))
  .subscribe();`}
        />
        <p className="text-muted-foreground text-xs">
          WS 404 হলে: <code>bash pluto-backend/deploy/repair-realtime-ws.sh</code>।
        </p>
      </Section>

      <Section n="Phase 7" title="Edge Functions / RPC" goal="Secret-বাহী server-side logic।">
        <CodeBlock
          lang="sql"
          code={`create or replace function public.get_my_stats()
returns jsonb language sql stable security definer set search_path=public
as $$ select jsonb_build_object('total', count(*))
      from public.notes where user_id = auth.uid() $$;
grant execute on function public.get_my_stats() to authenticated;`}
        />
        <CodeBlock lang="ts" code={`const { data } = await pluto.rpc("get_my_stats");`} />
      </Section>

      <Section n="Phase 8" title="Custom Domain + SSL" goal="app.example.com কে primary frontend পিন করা।">
        <CodeBlock
          lang="bash"
          code={`sudo bash pluto-backend/deploy/install-wildcard-tls.sh example.com
sudo bash pluto-backend/deploy/set-primary-frontend.sh <slug> app.example.com

curl -sI https://app.example.com/ | grep -i x-pluto-primary`}
        />
      </Section>

      <Section n="Phase 9" title="Deploy + Cutover" goal="GitHub → VPS → live in one command।">
        <CodeBlock
          lang="bash"
          code={`bash pluto-backend/deploy/safe-pull.sh
bash pluto-backend/deploy/build-and-cutover.sh <slug>`}
        />
        <p className="text-muted-foreground">
          বা dashboard-এ <strong>Auto-Deploy Studio</strong> → GitHub URL → Deploy। Result:{" "}
          <code>/dashboard/ops/executions</code>।
        </p>
      </Section>

      <Section
        n="Phase 10"
        title="Observability + Ops"
        goal="Production হাইজিন — approvals, backups, rollback, tracing।"
      >
        <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
          <li><code>/dashboard/ops/settings</code> — HMAC webhook secret, retention, prod approvals।</li>
          <li><code>/dashboard/traces/settings</code> — PII redaction (superadmin)।</li>
          <li><code>/dashboard/backups</code> — schedule + retention।</li>
          <li>Daily: dry-run → approve (prod) → apply → verify checklist green।</li>
        </ul>
        <div className="overflow-x-auto">
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr className="text-left border-b border-border">
                <th className="py-2 pr-4">Problem</th>
                <th className="py-2">Tool</th>
              </tr>
            </thead>
            <tbody className="text-muted-foreground">
              <tr><td className="py-1 pr-4">403 / access denied</td><td><code>/dashboard/ops/rls-debug</code>, <code>/dashboard/rbac-debug</code></td></tr>
              <tr><td className="py-1 pr-4">Slow query</td><td><code>/dashboard/ops/explain</code></td></tr>
              <tr><td className="py-1 pr-4">Token / role mismatch</td><td><code>/dashboard/ops/jwt-inspect</code></td></tr>
              <tr><td className="py-1 pr-4">DB / container connectivity</td><td><code>/dashboard/ops/docker-check</code></td></tr>
              <tr><td className="py-1 pr-4">Migration issue</td><td><code>/dashboard/ops/migrations</code></td></tr>
              <tr><td className="py-1 pr-4">Live errors</td><td><code>/dashboard/logs-explorer</code>, <code>/dashboard/traces</code></td></tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section n="Cheat" title="Cheat-sheet — এক নজরে সব কমান্ড" goal="Copy-paste ready।">
        <CodeBlock
          lang="bash"
          code={`# Migrations
sudo /usr/local/sbin/pluto-ops migrate plan
sudo /usr/local/sbin/pluto-ops migrate dry-run
sudo /usr/local/sbin/pluto-ops migrate apply
sudo /usr/local/sbin/pluto-ops migrate rollback --to 00XX

# Rollouts / backups
sudo /usr/local/sbin/pluto-ops rollout apply    --env prod
sudo /usr/local/sbin/pluto-ops rollout rollback --env prod
sudo /usr/local/sbin/pluto-ops backup create    --env prod
sudo /usr/local/sbin/pluto-ops backup prune     --env prod

# Live probes
curl -sI https://<domain>/ | grep -i x-pluto-primary
curl -s  https://api.timescard.cloud/v1/health | jq .`}
        />
      </Section>

      <section className="rounded-xl border border-primary/40 bg-primary/5 p-5 space-y-2">
        <h2 className="text-lg font-semibold">Golden rules</h2>
        <ol className="list-decimal pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Roles আলাদা <code>user_roles</code> table-এ — profile-এ কখনো নয়।</li>
          <li>Public table order: <strong>CREATE → GRANT → ENABLE RLS → POLICY</strong> — বাধ্যতামূলক।</li>
          <li><code>service_role</code> কখনো frontend-এ নয়।</li>
          <li>Migration idempotent (<code>if not exists</code>, <code>create or replace</code>)।</li>
          <li>Prod destructive action সর্বদা dry-run + approval-gate পার হবে।</li>
        </ol>
      </section>
    </div>
  );
}
