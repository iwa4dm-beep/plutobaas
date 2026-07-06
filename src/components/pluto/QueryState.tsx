import * as React from "react";
import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Shared UI primitives for dashboard data-fetching states.
 * Use these on every page so loaders / empty / error look consistent.
 */

export function LoadingPanel({
  rows = 5,
  className,
  label = "Loading…",
}: { rows?: number; className?: string; label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn("space-y-3", className)}
    >
      <span className="sr-only">{label}</span>
      <Skeleton className="h-9 w-1/3" />
      <div className="rounded-xl border border-border/60 bg-card/50 p-4 space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  title = "Nothing here yet",
  description,
  icon: Icon = Inbox,
  action,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center rounded-xl border border-dashed border-border/60 bg-card/40 py-12 px-6",
        className,
      )}
    >
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold font-display">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  retrying = false,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center text-center rounded-xl border border-destructive/40 bg-destructive/5 py-10 px-6",
        className,
      )}
    >
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <AlertTriangle className="h-5 w-5" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold font-display">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {typeof description === "string" ? description : description}
        </p>
      ) : null}
      {onRetry ? (
        <Button
          onClick={onRetry}
          disabled={retrying}
          size="sm"
          variant="outline"
          className="mt-4"
          aria-label="Retry loading"
        >
          <RefreshCw className={cn("mr-2 h-3.5 w-3.5", retrying && "animate-spin")} />
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
    </div>
  );
}

/** All-in-one wrapper: pick the right state for a data fetch. */
export function QueryState<T>({
  loading,
  error,
  data,
  onRetry,
  empty,
  loadingRows,
  isEmpty,
  children,
}: {
  loading?: boolean;
  error?: unknown;
  data?: T;
  onRetry?: () => void;
  empty?: React.ReactNode;
  loadingRows?: number;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => React.ReactNode;
}) {
  if (loading) return <LoadingPanel rows={loadingRows} />;
  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return <ErrorState description={msg} onRetry={onRetry} />;
  }
  if (data === undefined || data === null) return <>{empty ?? <EmptyState />}</>;
  if (isEmpty && isEmpty(data)) return <>{empty ?? <EmptyState />}</>;
  return <>{children(data)}</>;
}
