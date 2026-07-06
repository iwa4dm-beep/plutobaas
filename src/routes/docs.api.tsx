// Browser-hosted API reference.
//
// Renders the auto-generated OpenAPI 3.1 document (served at
// /admin/v1/schema/openapi.json) inside RapiDoc — a lightweight
// single-file custom element that ships as one <script> tag. Users can
// browse every REST endpoint, try requests inline, and copy curl
// snippets without leaving the dashboard.
//
// The GraphQL surface is documented separately (see the info banner
// below) — RapiDoc only knows about REST/OpenAPI.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { ExternalLink, FileJson } from "lucide-react";

export const Route = createFileRoute("/docs/api")({
  head: () => ({
    meta: [
      { title: "Pluto API Reference" },
      { name: "description", content: "Interactive reference for the Pluto REST, GraphQL, and observability APIs." },
      { property: "og:title", content: "Pluto API Reference" },
      { property: "og:description", content: "Interactive reference for the Pluto REST, GraphQL, and observability APIs." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ApiDocsPage,
});

// Loads the RapiDoc web component from a CDN exactly once per page load.
function useRapiDoc() {
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    if (customElements.get("rapi-doc")) return;
    const s = document.createElement("script");
    s.src = "https://unpkg.com/rapidoc@9.3.4/dist/rapidoc-min.js";
    s.type = "module";
    s.async = true;
    document.head.appendChild(s);
  }, []);
}

function ApiDocsPage() {
  useRapiDoc();

  const specUrl = useMemo(() => {
    const base = import.meta.env.VITE_PLUTO_URL ?? "";
    // Prefer the admin OpenAPI (workspace-aware) — falls back to /rest/v1/
    return `${String(base).replace(/\/$/, "")}/admin/v1/schema/openapi.json`;
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileJson className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-sm font-semibold">API Reference</h1>
            <p className="text-[11px] text-muted-foreground">
              Auto-generated from your schema. Try requests inline; scopes come from the tokens dashboard.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <Link to="/dashboard/api" className="text-primary hover:underline">← Schema browser</Link>
          <a href={specUrl} target="_blank" rel="noreferrer"
             className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            openapi.json <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </header>

      <div className="border-b border-border bg-muted/30 px-6 py-2 text-[11px] text-muted-foreground flex flex-wrap gap-4">
        <span><strong className="text-foreground">GraphQL:</strong> <code>POST /graphql/v1</code> — same auth, RLS applied</span>
        <span><strong className="text-foreground">Prometheus:</strong> <code>GET /metrics</code> — text exposition, no auth</span>
        <span><strong className="text-foreground">Realtime:</strong> <code>WS /rt/v1</code> — see the Realtime dashboard</span>
      </div>

      <div className="border-b border-border px-6 py-4">
        <h2 className="text-sm font-semibold mb-2">Endpoint reference</h2>
        <p className="text-xs text-muted-foreground mb-3">
          All routes are served under <code>{"{VITE_PLUTO_URL}"}</code> (same-origin via <code>/api/pluto/*</code> proxy).
          Auth: send <code>Authorization: Bearer &lt;access_token&gt;</code> + <code>apikey: &lt;VITE_PLUTO_ANON_KEY&gt;</code>.
          Admin routes additionally require a session with <code>is_superadmin=true</code> (or a service-role key).
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <RouteGroup title="Health" rows={[
            ["GET",  "/livez",  "Liveness probe"],
            ["GET",  "/readyz", "Readiness — DB + JWT"],
            ["GET",  "/health/migrations", "Applied migrations ledger"],
          ]} />
          <RouteGroup title="Auth" rows={[
            ["POST", "/auth/v1/signup",  "Email + password sign-up"],
            ["POST", "/auth/v1/token",   "Password / refresh grant"],
            ["POST", "/auth/v1/recover", "Send password reset email"],
            ["POST", "/auth/v1/verify",  "Verify email OTP"],
            ["POST", "/auth/v1/logout",  "Revoke current session"],
          ]} />
          <RouteGroup title="Admin · Users" badge="super_admin" rows={[
            ["GET",    "/admin/v1/users",       "List users (500 most recent)"],
            ["PATCH",  "/admin/v1/users/:id",   "Update role / is_superadmin / email_verified"],
            ["DELETE", "/admin/v1/users/:id",   "Delete a user (cannot delete self)"],
          ]} />
          <RouteGroup title="Admin · Projects & Keys" badge="super_admin" rows={[
            ["GET",  "/admin/v1/projects",                 "List projects"],
            ["POST", "/admin/v1/projects",                 "Create project"],
            ["GET",  "/admin/v1/projects/:id/members",     "List members"],
            ["POST", "/admin/v1/projects/:id/members",     "Add member (owner/admin/developer/viewer)"],
            ["GET",  "/admin/v1/projects/:id/keys",        "List API keys"],
            ["POST", "/admin/v1/projects/:id/keys",        "Mint API key"],
            ["POST", "/admin/v1/projects/:id/keys/:keyId/rotate", "Rotate API key"],
          ]} />
          <RouteGroup title="Admin · Audit & Studio" rows={[
            ["GET",  "/admin/v1/audit",                   "Paginated audit events"],
            ["GET",  "/admin/v1/studio/tables?schema=…",  "List tables in a schema"],
            ["GET",  "/admin/v1/studio/columns?schema=…&table=…", "Columns + FK + PK"],
            ["GET",  "/admin/v1/settings",                "Feature flags"],
          ]} />
          <RouteGroup title="Storage" rows={[
            ["GET",    "/storage/v1/bucket",           "List buckets"],
            ["POST",   "/storage/v1/bucket",           "Create bucket"],
            ["POST",   "/storage/v1/object/:bucket/*", "Upload object"],
            ["GET",    "/storage/v1/object/:bucket/*", "Download object"],
            ["DELETE", "/storage/v1/object/:bucket/*", "Delete object"],
          ]} />
          <RouteGroup title="Data API (REST)" rows={[
            ["GET",    "/rest/v1/:table?select=*",  "Select rows (PostgREST-compatible)"],
            ["POST",   "/rest/v1/:table",           "Insert rows"],
            ["PATCH",  "/rest/v1/:table?id=eq.…",   "Update rows"],
            ["DELETE", "/rest/v1/:table?id=eq.…",   "Delete rows"],
          ]} />
          <RouteGroup title="Jobs & Functions" rows={[
            ["GET",  "/jobs/v1/tokens",       "List job tokens"],
            ["POST", "/jobs/v1/tokens",       "Mint job token"],
            ["GET",  "/functions/v1/list",   "List edge functions"],
            ["POST", "/functions/v1/:slug",  "Invoke edge function"],
          ]} />
        </div>

        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">Not yet on the backend (returns 404 today)</summary>
          <ul className="mt-2 ml-4 list-disc space-y-0.5">
            <li><code>/admin/v1/stats</code>, <code>/admin/v1/workspaces</code>, <code>/admin/v1/integrations/health</code></li>
            <li><code>/admin/v1/sql/history</code>, <code>/admin/v1/cors/origins</code>, <code>/admin/v1/rate-limits</code></li>
            <li><code>/ai/v1/*</code>, <code>/queue/v1/*</code>, <code>/templates/v1</code>, <code>/push/v1/*</code></li>
            <li><code>/auth/v1/sso/providers</code>, WS <code>system:audit</code> / <code>system:migrations</code></li>
          </ul>
        </details>
      </div>

      <main className="flex-1 min-h-0">
        {/* RapiDoc is a custom element registered at runtime by the CDN script above. */}
        <div
          ref={(el) => {
            if (!el || el.firstChild) return;
            const doc = document.createElement("rapi-doc");
            doc.setAttribute("spec-url", specUrl);
            doc.setAttribute("render-style", "focused");
            doc.setAttribute("layout", "row");
            doc.setAttribute("theme", "dark");
            doc.setAttribute("bg-color", "hsl(222 47% 11%)");
            doc.setAttribute("text-color", "hsl(210 40% 96%)");
            doc.setAttribute("primary-color", "hsl(217 91% 60%)");
            doc.setAttribute("allow-authentication", "true");
            doc.setAttribute("allow-server-selection", "true");
            doc.setAttribute("allow-spec-url-load", "false");
            doc.setAttribute("allow-spec-file-load", "false");
            doc.setAttribute("persist-auth", "true");
            doc.setAttribute("show-header", "false");
            doc.style.height = "calc(100vh - 88px)";
            doc.style.width = "100%";
            el.appendChild(doc);
          }}
        />
      </main>
    </div>
  );
}

function RouteGroup({ title, rows, badge }: { title: string; rows: [string, string, string][]; badge?: string }) {
  return (
    <div className="rounded-md border border-border bg-card/50 p-3">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-xs font-semibold">{title}</h3>
        {badge && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">{badge}</span>}
      </div>
      <ul className="space-y-1 text-[11px] font-mono">
        {rows.map(([m, p, d]) => (
          <li key={m + p} className="flex items-baseline gap-2">
            <span className={"inline-block w-14 shrink-0 text-center rounded px-1 py-0.5 text-[10px] font-semibold " +
              (m === "GET" ? "bg-emerald-500/15 text-emerald-500" :
               m === "POST" ? "bg-blue-500/15 text-blue-500" :
               m === "PATCH" ? "bg-amber-500/15 text-amber-500" :
               m === "DELETE" ? "bg-red-500/15 text-red-500" : "bg-muted text-muted-foreground")}>{m}</span>
            <code className="text-foreground/90">{p}</code>
            <span className="text-muted-foreground truncate">— {d}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
