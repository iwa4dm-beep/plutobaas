import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/docs/sdk")({
  head: () => ({
    meta: [
      { title: "Pluto SDK — Quick Start & API Reference" },
      { name: "description", content: "Connect any app to Pluto in under 2 minutes. Auth, database, storage, realtime, onboarding — one SDK." },
      { property: "og:title", content: "Pluto SDK — Quick Start" },
      { property: "og:description", content: "Supabase-compatible client SDK for Pluto BaaS." },
    ],
  }),
  component: DocsSdk,
});

function Code({ children, lang = "bash" }: { children: string; lang?: string }) {
  return (
    <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 overflow-x-auto text-sm my-3">
      <code data-lang={lang}>{children.trim()}</code>
    </pre>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-10 scroll-mt-20">
      <h2 className="text-2xl font-semibold mb-3 border-b pb-2">{title}</h2>
      {children}
    </section>
  );
}

function DocsSdk() {
  const API = "https://api.timescard.cloud";

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <p className="text-sm text-muted-foreground mb-1">Documentation</p>
        <h1 className="text-4xl font-bold mb-2">Pluto SDK</h1>
        <p className="text-lg text-muted-foreground">
          Supabase-compatible client. Same API surface — auth, database, storage, realtime — plus native onboarding &amp; multi-tenant helpers.
        </p>
        <nav className="mt-4 flex flex-wrap gap-3 text-sm">
          <a href="#install" className="text-blue-600 hover:underline">Install</a>
          <a href="#init" className="text-blue-600 hover:underline">Initialize</a>
          <a href="#signup" className="text-blue-600 hover:underline">Self-serve signup</a>
          <a href="#auth" className="text-blue-600 hover:underline">Auth</a>
          <a href="#database" className="text-blue-600 hover:underline">Database</a>
          <a href="#storage" className="text-blue-600 hover:underline">Storage</a>
          <a href="#realtime" className="text-blue-600 hover:underline">Realtime</a>
          <a href="#domains" className="text-blue-600 hover:underline">Domains &amp; CORS</a>
          <a href="#invites" className="text-blue-600 hover:underline">Invites</a>
          <a href="#curl" className="text-blue-600 hover:underline">Raw HTTP</a>
        </nav>
      </header>

      <div className="rounded-lg border p-4 bg-amber-50 dark:bg-amber-950/20 text-sm mb-8">
        <strong>Need an account?</strong>{" "}
        <Link to="/signup" className="underline text-blue-600">Sign up</Link> — you'll get a workspace, project, and API keys instantly.
      </div>

      <Section id="install" title="1. Install">
        <Code lang="bash">{`npm install @pluto/js
# or
pnpm add @pluto/js
# or
bun add @pluto/js`}</Code>
      </Section>

      <Section id="init" title="2. Initialize the client">
        <p className="mb-2">Grab your <strong>publishable key</strong> from the dashboard (Project → API).</p>
        <Code lang="ts">{`import { createClient } from '@pluto/js';

const pluto = createClient(
  '${API}',
  'pk_live_your_publishable_key_here'
);`}</Code>
        <p className="text-sm text-muted-foreground">The publishable key is safe in browser code — Row-Level Security policies gate every table.</p>
      </Section>

      <Section id="signup" title="3. Self-serve signup (one call, full onboarding)">
        <p className="mb-2">
          Creates the user, a workspace, a project, API keys, adds the caller's domain to CORS, and seeds a demo table — all atomically.
        </p>
        <Code lang="ts">{`const { data, error } = await pluto.onboarding.signupFull({
  email: 'founder@acme.com',
  password: 'a-strong-password',
  workspace_name: 'Acme Inc',
  project_name: 'Production',
  domain: 'https://app.acme.com',
  seed_demo: true,
});

if (error) throw error;
console.log(data.api_keys.publishable);   // pk_live_...
console.log(data.api_keys.secret);        // sk_live_... (store server-side)
console.log(data.session.access_token);   // JWT — user is auto-logged-in`}</Code>
      </Section>

      <Section id="auth" title="4. Auth">
        <Code lang="ts">{`// sign in
await pluto.auth.signInWithPassword({ email, password });

// sign up (simple, no workspace)
await pluto.auth.signUp({ email, password });

// current session
const { data: { session } } = await pluto.auth.getSession();

// listen for changes
pluto.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') redirect('/login');
});

// sign out
await pluto.auth.signOut();`}</Code>
      </Section>

      <Section id="database" title="5. Database (REST + query builder)">
        <Code lang="ts">{`// select
const { data, error } = await pluto
  .from('posts')
  .select('id, title, author:users(name)')
  .eq('published', true)
  .order('created_at', { ascending: false })
  .limit(20);

// insert
await pluto.from('posts').insert({ title: 'Hello', body: '...' });

// update
await pluto.from('posts').update({ published: true }).eq('id', postId);

// delete
await pluto.from('posts').delete().eq('id', postId);

// call a Postgres function
const { data } = await pluto.rpc('search_posts', { q: 'hello' });`}</Code>
      </Section>

      <Section id="storage" title="6. Storage">
        <Code lang="ts">{`// upload
await pluto.storage.from('avatars').upload('user-123.png', file);

// public URL
const { data: { publicUrl } } = pluto.storage
  .from('avatars')
  .getPublicUrl('user-123.png');

// signed URL (private buckets)
const { data } = await pluto.storage
  .from('private-docs')
  .createSignedUrl('report.pdf', 60);`}</Code>
      </Section>

      <Section id="realtime" title="7. Realtime">
        <Code lang="ts">{`const channel = pluto
  .channel('room-42')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
    (payload) => console.log('new message', payload.new)
  )
  .subscribe();

// broadcast
await channel.send({ type: 'broadcast', event: 'typing', payload: { user: 'me' } });

// leave
await channel.unsubscribe();`}</Code>
      </Section>

      <Section id="domains" title="8. Manage domains / CORS programmatically">
        <p className="mb-2">Add a customer's domain from your onboarding flow — CORS auto-reloads within 15s.</p>
        <Code lang="ts">{`await pluto.domains.add(projectId, 'https://customer.example.com', 'Customer X');
const { data: domains } = await pluto.domains.list(projectId);
await pluto.domains.remove(projectId, domains![0].id);`}</Code>
      </Section>

      <Section id="invites" title="9. Admin invites">
        <Code lang="ts">{`// superadmin sends invite (48h single-use token)
const { data: invite } = await pluto.onboarding.createInvite('teammate@acme.com', 'admin');

// invited user accepts (link contains the token)
await pluto.onboarding.acceptInvite(tokenFromUrl, 'their-new-password');`}</Code>
      </Section>

      <Section id="curl" title="10. Prefer raw HTTP? Every SDK call is one endpoint.">
        <Code lang="bash">{`# Self-serve signup
curl -X POST ${API}/auth/v1/signup-full \\
  -H "Content-Type: application/json" \\
  -H "apikey: pk_live_..." \\
  -d '{"email":"you@x.com","password":"...","domain":"https://x.com"}'

# Select rows
curl "${API}/rest/v1/posts?select=*&published=eq.true" \\
  -H "apikey: pk_live_..." \\
  -H "Authorization: Bearer <access_token>"

# Add a domain
curl -X POST ${API}/admin/v1/projects/<id>/domains \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <access_token>" \\
  -d '{"origin":"https://customer.com"}'`}</Code>
      </Section>

      <footer className="mt-12 pt-6 border-t text-sm text-muted-foreground flex justify-between">
        <span>Base URL: <code className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{API}</code></span>
        <Link to="/docs/api" className="text-blue-600 hover:underline">Full REST reference →</Link>
      </footer>
    </div>
  );
}
