// Red/green live verification card for the app.timescard.cloud primary vhost.
// Calls verifyPrimaryLive (server function) which fetches the URL and reports
// whether the X-Pluto-Primary header is present. Auto-refreshes when the
// `refreshKey` prop changes (parent bumps it after every Auto Deploy).
import { useEffect, useState, useTransition } from "react";
import { useServerFn } from "@tanstack/react-start";
import { verifyPrimaryLive, type PrimaryVerifyResult } from "@/lib/pluto/vps-repair.functions";
import { CheckCircle2, XCircle, RefreshCw, ExternalLink } from "lucide-react";

type Props = {
  slug?: string;
  url?: string;
  refreshKey?: number; // bump to force re-check after a deploy
};

export function PrimaryHeaderVerifyCard({ slug, url, refreshKey }: Props) {
  const verify = useServerFn(verifyPrimaryLive);
  const [result, setResult] = useState<PrimaryVerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const run = () => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await verify({ data: { slug: slug || undefined, url: url || undefined } });
        setResult(r);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  };

  useEffect(() => { run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [refreshKey, slug, url]);

  const ok = result?.ok === true;
  const status = result?.status ?? 0;
  const tone = ok
    ? "border-green-500/40 bg-green-500/5"
    : result
      ? "border-red-500/40 bg-red-500/5"
      : "border-border bg-card";

  return (
    <section className={`rounded-xl border px-4 py-3 ${tone}`} aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {ok ? (
            <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
          ) : result ? (
            <XCircle className="h-5 w-5 text-red-600 shrink-0" />
          ) : (
            <RefreshCw className={`h-5 w-5 text-muted-foreground shrink-0 ${isPending ? "animate-spin" : ""}`} />
          )}
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {ok ? "Primary frontend live" : result ? "Primary frontend NOT routing" : "Checking primary frontend…"}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              curl -I{" "}
              <a href={result?.url ?? "https://app.timescard.cloud/"} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-1">
                {result?.url ?? "https://app.timescard.cloud/"}
                <ExternalLink className="h-3 w-3" />
              </a>
              {result ? (
                <> · HTTP {status} · {result.durationMs}ms · x-pluto-primary=<span className={ok ? "text-green-600" : "text-red-600"}>{result.primaryHeader || "(missing)"}</span></>
              ) : null}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
          Re-verify
        </button>
      </div>

      {result && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <KV label="X-Pluto-Primary" value={result.primaryHeader} good={!!result.primaryHeader} />
          <KV label="X-Pluto-Release" value={result.releaseHeader} good={!!result.releaseHeader} muted />
          <KV label="server" value={result.server} muted />
          <KV label="content-type" value={result.contentType} muted />
        </div>
      )}

      {(result?.hint || error) && (
        <div className={`mt-3 rounded-md border px-3 py-2 text-xs ${ok ? "border-green-500/30 bg-green-500/10 text-green-800 dark:text-green-300" : "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-300"}`}>
          {error ? `Verify failed: ${error}` : result?.hint}
        </div>
      )}
    </section>
  );
}

function KV({ label, value, good, muted }: { label: string; value: string | null | undefined; good?: boolean; muted?: boolean }) {
  const v = value && value.length > 0 ? value : "(missing)";
  const tone = good ? "text-green-700 dark:text-green-400" : muted ? "text-muted-foreground" : "text-red-700 dark:text-red-400";
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="text-muted-foreground min-w-32">{label}</span>
      <span className={`font-mono truncate ${tone}`}>{v}</span>
    </div>
  );
}
