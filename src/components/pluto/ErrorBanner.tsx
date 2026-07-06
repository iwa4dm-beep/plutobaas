import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { describeError } from "@/lib/pluto/live";

/**
 * ErrorBanner — surfaces backend failures on dashboard pages.
 *
 * Shows the status code, the backend `message`, and any structured
 * `error` / `hint` / `details` payload. When `onRetry` is provided,
 * renders a retry button so operators can re-run the failed action
 * without reloading the page. When `onDismiss` is provided, adds a
 * dismiss button so a stale error does not linger after a manual fix.
 */
export function ErrorBanner({
  error,
  onRetry,
  onDismiss,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}) {
  if (!error) return null;
  const info = describeError(error);
  return (
    <div
      role="alert"
      className={
        "mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive " +
        (className ?? "")
      }
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium break-words">{info.title}</div>
          {info.detail && (
            <div className="mt-1 text-xs text-destructive/80 break-words">{info.detail}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs hover:bg-destructive/10"
            >
              <RefreshCw className="h-3 w-3" /> Retry
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="inline-flex items-center rounded-md p-1 hover:bg-destructive/10"
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
