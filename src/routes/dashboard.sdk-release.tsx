import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

// Admin dashboard: shows the latest npm publish status for @timescard/pluto-js.
// Data comes from /downloads/release-status.json which the GitHub Actions
// workflow (sdk-release.yml) rewrites after every release attempt.
export const Route = createFileRoute("/dashboard/sdk-release")({
  head: () => ({ meta: [{ title: "SDK release status" }, { name: "robots", content: "noindex" }] }),
  component: SdkReleasePage,
});

type ReleaseStatus = {
  name: string;
  version: string;
  publish_status: "published" | "already_published" | "skipped" | "failed" | "missing_token";
  verify_status: "ok" | "install_failed" | "skipped";
  ran_at: string;
  run_url: string;
  sha256: { versioned: string; latest: string };
  publish_log_tail: string;
  install_log_tail: string;
  smoke_output: string;
};

type Manifest = {
  name: string;
  version: string;
  npm: string;
  files: { version: string; file: string; sha256: string; url: string }[];
};

const REPO = "timescard/pluto";
const WORKFLOW_URL = `https://github.com/${REPO}/actions/workflows/sdk-release.yml`;

function badge(text: string, tone: "ok" | "warn" | "err" | "muted") {
  const cls = {
    ok:    "bg-emerald-500/15 text-emerald-400 border-emerald-500/40",
    warn:  "bg-amber-500/15 text-amber-400 border-amber-500/40",
    err:   "bg-rose-500/15 text-rose-400 border-rose-500/40",
    muted: "bg-muted text-muted-foreground border-border",
  }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
}

function toneFor(s: ReleaseStatus["publish_status"]): "ok" | "warn" | "err" | "muted" {
  if (s === "published") return "ok";
  if (s === "already_published") return "warn";
  if (s === "failed" || s === "missing_token") return "err";
  return "muted";
}

function SdkReleasePage() {
  const status = useQuery<ReleaseStatus | null>({
    queryKey: ["sdk-release-status"],
    queryFn: async () => {
      const r = await fetch("/downloads/release-status.json", { cache: "no-store" });
      if (!r.ok) return null;
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const manifest = useQuery<Manifest | null>({
    queryKey: ["sdk-manifest"],
    queryFn: async () => {
      const r = await fetch("/downloads/manifest.json", { cache: "no-store" });
      if (!r.ok) return null;
      return r.json();
    },
    refetchInterval: 60_000,
  });

  const releaseInstructions = useMemo(() => `# Bump + build + publish locally
node scripts/sdk-publish.mjs patch

# Or trigger a real release from CI: push a tag
git tag v${manifest.data?.version ?? "0.1.1"}
git push --tags`, [manifest.data?.version]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">SDK Release</h1>
        <p className="text-sm text-muted-foreground">
          Publish status for <code>@timescard/pluto-js</code>. CI runs on git tags
          (<code>v*</code>) or manual dispatch.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Trigger a release</h2>
          <a
            href={WORKFLOW_URL}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary underline underline-offset-4"
          >
            Open GitHub Actions →
          </a>
        </div>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{releaseInstructions}</pre>
        <p className="text-xs text-muted-foreground">
          The workflow rebuilds the tarball, generates a changelog from commits,
          runs <code>npm publish --dry-run</code>, publishes, then verifies with
          a fresh <code>npm install</code>. Requires the <code>NPM_TOKEN</code>{" "}
          repo secret.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h2 className="text-lg font-medium">Latest publish</h2>
        {status.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {status.data === null && (
          <p className="text-sm text-muted-foreground">
            No release recorded yet. Trigger the workflow to populate this page.
          </p>
        )}
        {status.data && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-muted px-2 py-1">
                {status.data.name}@{status.data.version}
              </code>
              {badge(`publish: ${status.data.publish_status}`, toneFor(status.data.publish_status))}
              {badge(
                `verify: ${status.data.verify_status}`,
                status.data.verify_status === "ok" ? "ok" : status.data.verify_status === "install_failed" ? "err" : "muted",
              )}
              <span className="text-muted-foreground">{status.data.ran_at}</span>
              <a href={status.data.run_url} target="_blank" rel="noreferrer" className="ml-auto text-primary underline underline-offset-4">
                CI run →
              </a>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 text-xs">
              <div>
                <div className="text-muted-foreground">sha256 (versioned)</div>
                <code className="break-all">{status.data.sha256.versioned || "—"}</code>
              </div>
              <div>
                <div className="text-muted-foreground">sha256 (latest)</div>
                <code className="break-all">{status.data.sha256.latest || "—"}</code>
              </div>
            </div>

            <details className="rounded border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">Registry publish log</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{status.data.publish_log_tail || "(no log)"}</pre>
            </details>
            <details className="rounded border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">Fresh install output</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{status.data.install_log_tail || "(no log)"}</pre>
              <pre className="mt-2 whitespace-pre-wrap text-xs">{status.data.smoke_output}</pre>
            </details>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h2 className="text-lg font-medium">Available tarballs</h2>
        {manifest.data ? (
          <ul className="space-y-1 text-sm">
            {manifest.data.files.map((f) => (
              <li key={f.file} className="flex flex-wrap items-center gap-2">
                <a className="text-primary underline underline-offset-4" href={f.url}>{f.file}</a>
                <code className="rounded bg-muted px-2 py-0.5 text-xs break-all">{f.sha256}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">manifest.json not found</p>
        )}
      </section>
    </div>
  );
}
