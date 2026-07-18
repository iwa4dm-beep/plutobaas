import { useEffect } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { describeError } from "@/lib/pluto/live";
import { reportLovableError } from "@/lib/lovable-error-reporting";

/**
 * RouteErrorBoundary — canonical error UI used by every route (and the
 * root router) when an uncaught error escapes a loader / component.
 * Renders the same friendly title + detail + hint layout as ErrorBanner
 * so users see a consistent bilingual message anywhere the app crashes.
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
  const info = describeError(error);

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[RouteErrorBoundary]", boundary, error);
    reportLovableError(error, { boundary });
  }, [error, boundary]);

  const retry = () => {
    router.invalidate();
    reset?.();
  };

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
            {typeof info.status === "number" && (
              <p className="mt-2 text-xs text-muted-foreground">
                HTTP {info.status}
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={retry}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Try again
              </button>
              <Link
                to="/"
                className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                <Home className="h-3.5 w-3.5" /> Go home
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
