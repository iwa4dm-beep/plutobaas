import { useEffect, useState } from "react";
import { Link, useRouter, useNavigate, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw, Home, LogIn, Copy, Check, LifeBuoy } from "lucide-react";
import { describeError } from "@/lib/pluto/live";
import { reportLovableError } from "@/lib/lovable-error-reporting";
import { parseAuthFailure, logAuthFailure } from "@/lib/pluto/auth-error";

const SUPPORT_EMAIL = "support@timescard.cloud";

/**
 * RouteErrorBoundary — canonical error UI used by every route (and the
 * root router) when an uncaught error escapes a loader / component.
 *
 * Special-case: `PlutoAuthError_401` / any 401 → auto-navigate to `/auth`
 * with a return path + `reason=session_expired`, and never show the
 * generic red banner. This kills the blank-screen behaviour that used to
 * happen when admin server-fns threw 401.
 */
export function RouteErrorBoundary({
  error,
  reset,
  boundary = "route",
}: {
  error: unknown;
  reset?: () => void;
  boundary?: string;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const info = describeError(error);
  const auth = parseAuthFailure(error);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[RouteErrorBoundary]", boundary, error);
    reportLovableError(error, { boundary });
    if (auth?.status === 401) {
      logAuthFailure(`route-boundary:${boundary}`, error, { route: pathname });
    }
  }, [error, boundary, auth?.status, pathname]);

  // 401 → clean redirect. We use a client-only effect so SSR doesn't try
  // to touch `window`.
  useEffect(() => {
    if (auth?.status !== 401) return;
    if (typeof window === "undefined") return;
    // Avoid loop if we're already on /auth.
    if (pathname.startsWith("/auth")) return;
    navigate({
      to: "/auth",
      search: { redirect: pathname, reason: "session_expired" } as never,
      replace: true,
    });
  }, [auth?.status, navigate, pathname]);

  if (auth?.status === 401) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center px-4 py-10">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-sm text-center">
          <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
            <LogIn className="h-4 w-4" />
          </div>
          <h2 className="text-base font-semibold text-foreground">Session expired</h2>
          <p className="mt-1 text-muted-foreground">
            আপনার session শেষ হয়ে গেছে — sign in পাতায় নিয়ে যাচ্ছি…
          </p>
          <div className="mt-4">
            <Link
              to="/auth"
              search={{ redirect: pathname, reason: "session_expired" } as never}
              replace
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <LogIn className="h-3.5 w-3.5" /> Sign in again
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const retry = () => {
    router.invalidate();
    reset?.();
  };

  return <ErrorFallbackCard info={info} onRetry={retry} pathname={pathname} />;
}

/**
 * ErrorFallbackCard — the visual shell used by RouteErrorBoundary AND by
 * standalone client error pages (e.g. lazy-import failures). Exported so
 * any client route can render the same UX with a custom `info` payload.
 */
export function ErrorFallbackCard({
  info,
  onRetry,
  pathname,
}: {
  info: { title: string; detail?: string; status?: number; hint?: string; traceId?: string; fields?: Record<string, string> };
  onRetry?: () => void;
  pathname?: string;
}) {
  const [copied, setCopied] = useState(false);
  const fieldEntries = info.fields ? Object.entries(info.fields) : [];

  const copyTrace = async () => {
    if (!info.traceId) return;
    try {
      await navigator.clipboard.writeText(info.traceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const supportHref = (() => {
    const subject = encodeURIComponent(`Error report${info.traceId ? ` — trace ${info.traceId}` : ""}`);
    const bodyLines = [
      `Page: ${pathname ?? (typeof window !== "undefined" ? window.location.pathname : "")}`,
      info.status ? `HTTP: ${info.status}` : "",
      info.traceId ? `Trace ID: ${info.traceId}` : "",
      info.title ? `Message: ${info.title}` : "",
      info.detail ? `Detail: ${info.detail}` : "",
    ].filter(Boolean).join("\n");
    return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${encodeURIComponent(bodyLines)}`;
  })();

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <div
        role="alert"
        className="w-full max-w-lg rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">
              {info.title || "Something went wrong"}
            </h2>
            {info.detail && (
              <p className="mt-1 break-words text-sm text-muted-foreground">
                {info.detail}
              </p>
            )}
            {info.hint && info.hint !== info.detail && (
              <p className="mt-2 rounded-md bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                {info.hint}
              </p>
            )}
            {fieldEntries.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-md border border-border/60 bg-background/40 px-3 py-2 text-xs">
                {fieldEntries.map(([field, msg]) => (
                  <li key={field}>
                    <span className="font-mono font-medium text-foreground">{field}</span>
                    <span className="text-muted-foreground"> — {msg}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {typeof info.status === "number" && <span>HTTP {info.status}</span>}
              {info.traceId && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">Trace {info.traceId}</span>
                  <button
                    type="button"
                    onClick={copyTrace}
                    className="inline-flex items-center gap-1 rounded border border-input bg-background px-1.5 py-0.5 text-[11px] hover:bg-accent"
                    aria-label="Copy trace ID"
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Try again
                </button>
              )}
              <Link
                to="/"
                className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                <Home className="h-3.5 w-3.5" /> Go home
              </Link>
              <a
                href={supportHref}
                className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                <LifeBuoy className="h-3.5 w-3.5" /> Contact support
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
