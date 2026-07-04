import { Radio, AlertTriangle, Loader2 } from "lucide-react";

export type PresenceStatus = "idle" | "connecting" | "live" | "retrying" | "failed";

interface Props {
  status: PresenceStatus;
  attempt: number;
  channel?: string;
  lastError?: string | null;
}

const dot: Record<PresenceStatus, string> = {
  idle:       "bg-muted-foreground/40",
  connecting: "bg-amber-500 animate-pulse",
  live:       "bg-emerald-500",
  retrying:   "bg-amber-500 animate-pulse",
  failed:     "bg-destructive",
};

const label: Record<PresenceStatus, string> = {
  idle:       "Not joined",
  connecting: "Connecting…",
  live:       "Live",
  retrying:   "Reconnecting",
  failed:     "Disconnected",
};

// Small badge summarising presence subscription health. Hover reveals
// channel name, attempt counter, and last error when relevant.
export function PresenceIndicator({ status, attempt, channel, lastError }: Props) {
  const title = [
    channel ? `channel: ${channel}` : null,
    `status: ${label[status]}`,
    attempt > 0 ? `attempt: ${attempt}` : null,
    lastError ? `error: ${lastError}` : null,
  ].filter(Boolean).join("\n");

  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border border-border bg-card"
    >
      <span className={`h-2 w-2 rounded-full ${dot[status]}`} />
      {status === "connecting" || status === "retrying"
        ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        : status === "failed"
          ? <AlertTriangle className="h-3 w-3 text-destructive" />
          : <Radio className="h-3 w-3 text-muted-foreground" />}
      <span>{label[status]}{status === "retrying" && attempt > 0 ? ` (#${attempt})` : ""}</span>
    </span>
  );
}
