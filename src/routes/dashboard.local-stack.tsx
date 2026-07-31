import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Download, Container, Copy, Check } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import {
  DEFAULT_LOCAL_STACK, buildLocalStackBundle, withGeneratedSecrets,
  downloadFile, randomHex, type LocalStackConfig,
} from "@/lib/pluto/local-stack";

export const Route = createFileRoute("/dashboard/local-stack")({
  head: () => ({
    meta: [
      { title: "Local Docker stack — Pluto BaaS" },
      { name: "description", content: "Generate a one-click Docker Compose bundle that boots Pluto locally and runs connection, migration and verification from a single .env." },
      { property: "og:title", content: "Local Docker stack — Pluto BaaS" },
      { property: "og:description", content: "One command: boot, migrate, import and verify your local Pluto backend." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LocalStackPage,
});

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="block text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

const input = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";

function LocalStackPage() {
  const [cfg, setCfg] = useState<LocalStackConfig>(() => withGeneratedSecrets(DEFAULT_LOCAL_STACK));
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  const files = useMemo(() => buildLocalStackBundle(cfg), [cfg]);
  const set = <K extends keyof LocalStackConfig>(k: K, v: LocalStackConfig[K]) =>
    setCfg((c) => ({ ...c, [k]: v }));

  async function copy(text: string, id: string) {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  }

  function downloadAll() {
    files.forEach((f, i) =>
      setTimeout(() => downloadFile(`${cfg.projectName}-${f.path.replace(/\//g, "-")}`, f.contents), i * 250),
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Local Docker stack"
        description="One command boots Postgres, storage, mail and the Pluto API — then applies migrations, your import, and a first verification pass. Every step reads the same .env."
      />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Container className="h-4 w-4" /> Stack settings
          </h2>

          <Field label="Project name">
            <input className={input} value={cfg.projectName} onChange={(e) => set("projectName", e.target.value)} />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="API port">
              <input className={input} type="number" value={cfg.apiPort} onChange={(e) => set("apiPort", Number(e.target.value))} />
            </Field>
            <Field label="Postgres port">
              <input className={input} type="number" value={cfg.dbPort} onChange={(e) => set("dbPort", Number(e.target.value))} />
            </Field>
          </div>

          <Field label="Frontend origin (CORS)">
            <input className={input} value={cfg.frontendOrigin} onChange={(e) => set("frontendOrigin", e.target.value)} />
          </Field>

          <Field label="Import SQL path" hint="Applied after migrations, e.g. a Supabase dump.">
            <input className={input} value={cfg.importSqlPath} onChange={(e) => set("importSqlPath", e.target.value)} />
          </Field>

          <div className="space-y-1 pt-1">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={cfg.withMinio} onChange={(e) => set("withMinio", e.target.checked)} />
              MinIO object storage
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={cfg.withMailpit} onChange={(e) => set("withMailpit", e.target.checked)} />
              Mailpit (catch auth emails)
            </label>
          </div>

          <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-2">
            <div className="text-xs font-medium">Generated secrets</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">JWT {cfg.jwtSecret.slice(0, 18)}…</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{cfg.anonKey}</div>
            <button
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
              onClick={() => setCfg((c) => ({
                ...c,
                jwtSecret: randomHex(32),
                anonKey: `pluto_anon_${randomHex(16)}`,
                serviceKey: `pluto_service_${randomHex(24)}`,
              }))}
            >
              Regenerate
            </button>
          </div>

          <button
            onClick={downloadAll}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Download className="h-4 w-4" /> Download bundle ({files.length} files)
          </button>
          <p className="text-[11px] text-muted-foreground">
            Put the files in one folder, then run <code className="font-mono">chmod +x bootstrap.sh verify.sh &amp;&amp; ./bootstrap.sh</code>.
          </p>
        </section>

        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap gap-1">
            {files.map((f, i) => (
              <button
                key={f.path}
                onClick={() => setActive(i)}
                className={`rounded-md px-2.5 py-1 font-mono text-xs ${i === active ? "bg-primary text-primary-foreground" : "border border-border hover:bg-muted"}`}
              >
                {f.path}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{files[active].language}</span>
            <div className="flex gap-2">
              <button
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                onClick={() => copy(files[active].contents, files[active].path)}
              >
                {copied === files[active].path ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Copy
              </button>
              <button
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                onClick={() => downloadFile(files[active].path.replace(/\//g, "-"), files[active].contents)}
              >
                <Download className="h-3 w-3" /> Download
              </button>
            </div>
          </div>

          <pre className="max-h-[560px] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
            {files[active].contents}
          </pre>
        </section>
      </div>
    </div>
  );
}
