import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ArrowLeft, Clock, KeyRound, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";
import { whoAmIToBackend, type BackendClaimsView } from "@/lib/pluto/jwt-inspect.functions";

export const Route = createFileRoute("/dashboard/ops/jwt-inspect")({
  component: JwtInspectPage,
  head: () => ({
    meta: [
      { title: "JWT claims inspector — Pluto BaaS" },
      { name: "description", content: "Decode the current Pluto session JWT: header, claims, exp/iat/nbf, refresh status, and the Postgres role the backend maps you to." },
      { property: "og:title", content: "JWT claims inspector — Pluto BaaS" },
      { property: "og:description", content: "Verify header, claims, token lifetime, and effective backend role for your Pluto session." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

const SESSION_KEY = "pluto.session.v1";

type LocalSession = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  user?: { id?: string; email?: string; role?: string };
} | null;

type DecodedJwt = {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signaturePresent: boolean;
  raw: { header: string; payload: string; signature: string };
};

function b64urlDecode(s: string): string {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  try { return atob(b64); } catch { return ""; }
}

function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64urlDecode(parts[0]) || "{}");
    const claims = JSON.parse(b64urlDecode(parts[1]) || "{}");
    return { header, claims, signaturePresent: parts[2].length > 0, raw: { header: parts[0], payload: parts[1], signature: parts[2] } };
  } catch { return null; }
}

function readSession(): LocalSession {
  if (typeof window === "undefined") return null;
  try { const raw = window.localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function fmtTs(sec: unknown): string {
  const n = typeof sec === "number" ? sec : Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n * 1000).toISOString();
}

function relative(sec: unknown): string {
  const n = typeof sec === "number" ? sec : Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const diff = n * 1000 - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(mins / 60);
  const label = hrs >= 1 ? `${hrs}h${mins % 60}m` : `${mins}m`;
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}

function JwtInspectPage() {
  return (
    <TraceAccessGate permission="view">
      <JwtInspectInner />
    </TraceAccessGate>
  );
}

function JwtInspectInner() {
  const [session, setSession] = useState<LocalSession>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [backend, setBackend] = useState<BackendClaimsView | null>(null);
  const [backendErr, setBackendErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const who = useServerFn(whoAmIToBackend);

  useEffect(() => { setSession(readSession()); }, []);

  const decoded = useMemo(() => (session?.access_token ? decodeJwt(session.access_token) : null), [session]);
  const now = Math.floor(Date.now() / 1000);
  const exp = decoded?.claims.exp as number | undefined;
  const iat = decoded?.claims.iat as number | undefined;
  const expired = typeof exp === "number" && exp < now;
  const expiringSoon = typeof exp === "number" && exp - now < 60;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const { live } = await import("@/lib/pluto/live");
      await live.auth.refresh();
      setSession(readSession());
    } finally { setRefreshing(false); }
  }, []);

  const verifyBackend = useCallback(async () => {
    setBusy(true); setBackendErr(null);
    try { setBackend(await who()); }
    catch (e) { setBackendErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [who]);

  useEffect(() => { void verifyBackend(); }, [verifyBackend]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/dashboard/ops" search={{ env: "prod" }} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Operations
        </Link>
      </div>

      <PageHeader
        title="JWT claims inspector"
        subtitle="Everything the Pluto backend and your browser know about the current session token — header, claims, expiry, refresh state, and the effective Postgres role."
      />

      {!session?.access_token && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          No Pluto session found in <code>localStorage["{SESSION_KEY}"]</code>. Sign in and reload.
        </div>
      )}

      {decoded && (
        <>
          <section className="rounded-lg border border-border bg-card p-4 space-y-2">
            <header className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              <h2 className="text-sm font-semibold">Lifetime</h2>
              {expired && <span className="rounded bg-destructive/20 px-2 py-0.5 text-xs text-destructive">expired</span>}
              {!expired && expiringSoon && <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-500">expiring &lt; 60s</span>}
              <button onClick={refresh} disabled={refreshing}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 text-xs font-medium hover:bg-secondary/80 disabled:opacity-50">
                {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh token
              </button>
            </header>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
              <div><span className="text-muted-foreground">iat</span> {fmtTs(iat)} <span className="text-muted-foreground">({relative(iat)})</span></div>
              <div><span className="text-muted-foreground">exp</span> {fmtTs(exp)} <span className="text-muted-foreground">({relative(exp)})</span></div>
              <div><span className="text-muted-foreground">nbf</span> {fmtTs(decoded.claims.nbf)}</div>
              <div><span className="text-muted-foreground">local.expires_at</span> {fmtTs(session?.expires_at)}</div>
              <div><span className="text-muted-foreground">refresh_token</span> {session?.refresh_token ? "present" : <span className="text-destructive">missing</span>}</div>
              <div><span className="text-muted-foreground">signature</span> {decoded.signaturePresent ? "present" : <span className="text-destructive">unsigned</span>}</div>
            </dl>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 space-y-2">
            <header className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              <h2 className="text-sm font-semibold">Backend role interpretation</h2>
              <button onClick={verifyBackend} disabled={busy}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 text-xs font-medium hover:bg-secondary/80 disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                Re-verify
              </button>
            </header>
            {backendErr && (
              <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                <AlertTriangle className="inline h-3 w-3 mr-1" />{backendErr}
              </p>
            )}
            {backend && (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
                <div><span className="text-muted-foreground">userId</span> {backend.userId}</div>
                <div><span className="text-muted-foreground">email</span> {backend.email}</div>
                <div><span className="text-muted-foreground">role (app)</span> {backend.role}</div>
                <div><span className="text-muted-foreground">effective PG role</span> <span className="rounded bg-secondary px-1.5 py-0.5">{backend.effectivePostgresRole}</span></div>
                <div><span className="text-muted-foreground">is_superadmin</span> {String(backend.isSuperadmin)}</div>
                <div><span className="text-muted-foreground">verified via</span> {backend.claimsSource}</div>
              </dl>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card p-4 space-y-2">
            <header className="flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              <h2 className="text-sm font-semibold">Header</h2>
            </header>
            <pre className="text-xs font-mono whitespace-pre-wrap rounded bg-muted p-2">{JSON.stringify(decoded.header, null, 2)}</pre>
          </section>

          <section className="rounded-lg border border-border bg-card p-4 space-y-2">
            <h2 className="text-sm font-semibold">Claims (unverified — local decode only)</h2>
            <pre className="text-xs font-mono whitespace-pre-wrap rounded bg-muted p-2 max-h-96 overflow-auto">{JSON.stringify(decoded.claims, null, 2)}</pre>
          </section>

          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Raw token parts</summary>
            <div className="mt-2 space-y-2 font-mono break-all">
              <div><span className="text-muted-foreground">header:</span> {decoded.raw.header}</div>
              <div><span className="text-muted-foreground">payload:</span> {decoded.raw.payload}</div>
              <div><span className="text-muted-foreground">signature:</span> {decoded.raw.signature.slice(0, 32)}…</div>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
