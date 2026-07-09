import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { getUpstream, pushUiHistory } from "@/lib/pluto/upstream";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/pluto-sdk")({
  component: SdkPage,
  head: () => ({ meta: [{ title: "Pluto CLI & SDK" }] }),
});

function SdkPage() {
  const [projectId, setProjectId] = useState("");
  const [schemas, setSchemas] = useState("public");
  const [preview, setPreview] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const { url, token } = getUpstream();

  async function fetchSdk(download = false) {
    if (!url) { setErr("Configure Pluto upstream URL first."); return; }
    try {
      const res = await fetch(
        `${url}/admin/v1/sdk/generate?project_id=${projectId}&schemas=${encodeURIComponent(schemas)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error(await res.text());
      const text = await res.text();
      if (download) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type: "application/typescript" }));
        a.download = `pluto-sdk-${projectId.slice(0, 8)}.ts`;
        a.click();
        pushUiHistory({ action: "sdk.download", ok: true });
      } else {
        setPreview(text);
      }
      setErr(null);
    } catch (e: any) { setErr(e.message); }
  }

  const cliInstall = `# Install
npm install -g @pluto/cli   # or use directly:
node pluto-backend/packages/cli/bin/pluto.mjs help

# Login and link
pluto login ${url || "https://api.example.com"} --email you@example.com --password ***
pluto link --project ${projectId || "<PROJECT_UUID>"}

# Everyday commands
pluto db push migrations/
pluto gen sdk --out ./src/pluto.ts
pluto functions deploy hello ./functions/hello.js
pluto backups create
pluto webhooks list`;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">CLI & Typed SDK</h1>
      <AutoHelpPanel slug={'dashboard.pluto-sdk'} title={'CLI & Typed SDK'} description={''} />
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{err}</div>}

      <section>
        <h2 className="text-sm font-medium mb-2">Pluto CLI</h2>
        <pre className="bg-muted/40 p-3 text-xs rounded overflow-auto">{cliInstall}</pre>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Generate typed TypeScript SDK</h2>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="flex flex-col text-xs">Project ID
            <input value={projectId} onChange={(e) => setProjectId(e.target.value)}
              className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm w-[320px]" placeholder="uuid" />
          </label>
          <label className="flex flex-col text-xs">Schemas (csv)
            <input value={schemas} onChange={(e) => setSchemas(e.target.value)}
              className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm w-[200px]" />
          </label>
          <button disabled={!projectId} onClick={() => fetchSdk(false)} className="rounded-md border text-sm px-3 py-2">Preview</button>
          <button disabled={!projectId} onClick={() => fetchSdk(true)} className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2 disabled:opacity-50">Download .ts</button>
        </div>
        {preview && (
          <pre className="bg-muted/40 p-2 text-xs rounded h-[420px] overflow-auto">{preview}</pre>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium mb-2">Usage</h2>
        <pre className="bg-muted/40 p-3 text-xs rounded overflow-auto">{`import { createClient } from "./pluto-sdk";

const pluto = createClient({
  url: "${url || "https://api.example.com"}",
  apiKey: "<PROJECT_ANON_KEY>",
});

const users = await pluto.from("users").select("id,email,name");
await pluto.from("posts").insert({ title: "hello" });`}</pre>
      </section>
    </div>
  );
}
