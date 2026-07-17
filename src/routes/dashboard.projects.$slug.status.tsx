import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, XCircle, AlertCircle, RefreshCw, ExternalLink, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";

export const Route = createFileRoute("/dashboard/projects/$slug/status")({
  component: ProjectStatusPage,
});

type SiteMapping = {
  slug: string;
  apex: string;
  apiUrl: string;
  prodUrl: string;
  previewUrl: string;
  workerBase: string;
  siteStatus: string;
};

type SiteStatus = {
  ok: boolean;
  slug: string;
  workspaceId?: string;
  bundleUploaded?: boolean;
  migrationsApplied?: unknown;
  staticServing?: boolean;
  previewServing?: boolean;
  channel?: string;
  servedAt?: string | null;
  sizeBytes?: number | null;
  envInjected?: boolean;
  ready?: boolean;
  error?: string;
  autoSeeded?: boolean;
};

type UrlProbe = { url: string; status: number; ok: boolean; error?: string };

async function probe(url: string): Promise<UrlProbe> {
  try {
    // no-cors to avoid CORS blowups on cross-origin subdomains; the browser
    // still reports opaque success as "ok" and network failures as thrown.
    await fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store" });
    return { url, status: 0, ok: true };
  } catch (e) {
    return { url, status: 0, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function ProjectStatusPage() {
  const { slug } = Route.useParams();
  const [mapping, setMapping] = useState<SiteMapping | null>(null);
  const [status, setStatus] = useState<SiteStatus | null>(null);
  const [prodProbe, setProdProbe] = useState<UrlProbe | null>(null);
  const [previewProbe, setPreviewProbe] = useState<UrlProbe | null>(null);
  const [loading, setLoading] = useState(false);
  const [healing, setHealing] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const m = (await fetch(`/api/public/site-mapping/${encodeURIComponent(slug)}`, { cache: "no-store" }).then((r) => r.json())) as SiteMapping;
      setMapping(m);
      const s = await fetch(m.siteStatus, { cache: "no-store" })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, slug, error: e instanceof Error ? e.message : String(e) } as SiteStatus));
      setStatus(s as SiteStatus);
      const [p, pv] = await Promise.all([probe(m.prodUrl), probe(m.previewUrl)]);
      setProdProbe(p);
      setPreviewProbe(pv);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const heal = useCallback(async () => {
    if (!mapping) return;
    setHealing(true);
    setErr(null);
    try {
      // Ask the worker to auto-seed a placeholder in-process. Public endpoint;
      // header is honoured only when there's no live bundle for this slug.
      await fetch(`${mapping.siteStatus}?autoseed=1`, {
        headers: { "x-pluto-auto-seed": "1" },
        cache: "no-store",
      });
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setHealing(false);
    }
  }, [mapping, load]);

  const bundleReady = Boolean(status?.ok && status?.staticServing);
  const isPlaceholder = Boolean((status as unknown as { placeholder?: boolean })?.placeholder || status?.autoSeeded);
  const dnsTlsOk = Boolean(prodProbe?.ok);

  return (
    <div>
      <PageHeader
        title={`Project status — ${slug}`}
        description="Auto Deploy, migrations, on-disk bundle, DNS/TLS in one view. Use Heal to seed a placeholder when nothing has been deployed yet."
      />

      <ErrorBanner error={err} onRetry={() => void load()} onDismiss={() => setErr(null)} />

      <div className="mb-4 flex gap-2">
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent/60 disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
        </button>
        <button
          onClick={() => void heal()}
          disabled={healing || !mapping}
          className="inline-flex items-center gap-2 rounded border border-border bg-primary/10 px-3 py-1.5 text-sm text-primary hover:bg-primary/20 disabled:opacity-60"
        >
          {healing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertCircle className="h-3.5 w-3.5" />}
          Heal (auto-seed placeholder)
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatusCard
          label="Auto Deploy bundle"
          state={bundleReady ? (isPlaceholder ? "warn" : "ok") : "bad"}
          hint={
            bundleReady
              ? isPlaceholder
                ? "Placeholder is serving — run Auto Deploy to publish your real build."
                : "Real bundle is live."
              : "No bundle unpacked on disk yet. Click Heal to seed a placeholder, or run Auto Deploy."
          }
          extra={status?.servedAt ? `Served at ${new Date(status.servedAt).toLocaleString()}` : undefined}
        />
        <StatusCard
          label="Migrations"
          state={
            status?.migrationsApplied === null || status?.migrationsApplied === undefined
              ? "unknown"
              : "ok"
          }
          hint={
            status?.migrationsApplied === null || status?.migrationsApplied === undefined
              ? "Deployer did not record migration status in the bundle manifest yet."
              : "Migration count recorded by the deployer at the last unpack."
          }
          extra={typeof status?.migrationsApplied === "number" ? `${status.migrationsApplied} applied` : undefined}
        />
        <StatusCard
          label="On-disk static"
          state={status?.staticServing ? "ok" : status?.previewServing ? "warn" : "bad"}
          hint={
            status?.staticServing
              ? "Worker resolves current symlink to a live index.html."
              : status?.previewServing
              ? "Only the preview channel has a bundle."
              : "No current/preview symlink resolves to a bundle."
          }
          extra={status?.channel ? `channel: ${status.channel}` : undefined}
        />
        <StatusCard
          label="DNS + TLS"
          state={dnsTlsOk ? "ok" : "bad"}
          hint={
            dnsTlsOk
              ? "Wildcard subdomain resolves and TLS negotiates."
              : "Wildcard subdomain didn't respond. Ensure DNS + wildcard cert are in place."
          }
          extra={prodProbe?.error ? prodProbe.error.slice(0, 80) : undefined}
        />
      </div>

      {mapping && (
        <section className="mt-6 grid gap-3 rounded-lg border border-border bg-card p-4 text-sm">
          <div className="text-xs font-medium uppercase text-muted-foreground">URLs</div>
          <UrlRow label="Production" url={mapping.prodUrl} probe={prodProbe} />
          <UrlRow label="Preview" url={mapping.previewUrl} probe={previewProbe} />
          <UrlRow label="API-hosted" url={`${mapping.apiUrl}/sites/${slug}/`} />
          <UrlRow label="Site-status JSON" url={mapping.siteStatus} />
        </section>
      )}

      {status && (
        <details className="mt-4 rounded-lg border border-border bg-card p-4 text-xs">
          <summary className="cursor-pointer font-medium">Raw /site-status response</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(status, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function StatusCard({
  label,
  state,
  hint,
  extra,
}: {
  label: string;
  state: "ok" | "warn" | "bad" | "unknown";
  hint: string;
  extra?: string;
}) {
  const styles: Record<typeof state, { icon: React.ReactElement; ring: string }> = {
    ok: { icon: <CheckCircle2 className="h-5 w-5 text-emerald-500" />, ring: "border-emerald-500/40" },
    warn: { icon: <AlertCircle className="h-5 w-5 text-amber-500" />, ring: "border-amber-500/40" },
    bad: { icon: <XCircle className="h-5 w-5 text-red-500" />, ring: "border-red-500/40" },
    unknown: { icon: <AlertCircle className="h-5 w-5 text-muted-foreground" />, ring: "border-border" },
  };
  const s = styles[state];
  return (
    <div className={`rounded-lg border bg-card p-4 ${s.ring}`}>
      <div className="flex items-start gap-2">
        {s.icon}
        <div className="flex-1">
          <div className="text-sm font-medium">{label}</div>
          <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
          {extra && <div className="mt-2 text-[11px] text-muted-foreground">{extra}</div>}
        </div>
      </div>
    </div>
  );
}

function UrlRow({ label, url, probe }: { label: string; url: string; probe?: UrlProbe | null }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-border/60 px-3 py-2">
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-xs">{url}</div>
      </div>
      <div className="flex items-center gap-2">
        {probe && (
          <span
            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
              probe.ok ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"
            }`}
          >
            {probe.ok ? "reachable" : "unreachable"}
          </span>
        )}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent/60"
        >
          Open <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}
