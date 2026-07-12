// Phase 3 UI: Deploy migrations SQL + bundle artifact to VPS with per-step progress.
//
// Steps (visible progress list):
//   1) Push migrations SQL   → pushMigrations
//   2) Upload bundle ZIP     → uploadBundle (chunked base64)
//   3) Verify deployment     → verifyDeploy
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Rocket, Loader2, CheckCircle2, XCircle, Circle, Upload as UploadIcon } from "lucide-react";
import { pushMigrations, uploadBundle, verifyDeploy } from "@/lib/pluto/vps-deployer.functions";

type StepState = "idle" | "running" | "ok" | "error";
type StepInfo = { key: "sql" | "upload" | "verify"; label: string; state: StepState; detail?: string };

const INITIAL: StepInfo[] = [
  { key: "sql", label: "Push migrations SQL", state: "idle" },
  { key: "upload", label: "Upload bundle to storage", state: "idle" },
  { key: "verify", label: "Verify latest deployment", state: "idle" },
];

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  // chunked to avoid stack overflow on large arrays
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function DeployToVpsCard({
  defaultSql,
  defaultBundle,
  defaultBundleName,
}: {
  defaultSql?: string;
  defaultBundle?: Blob | null;
  defaultBundleName?: string;
}) {
  const push = useServerFn(pushMigrations);
  const upload = useServerFn(uploadBundle);
  const verify = useServerFn(verifyDeploy);

  const [workspaceId, setWorkspaceId] = useState("");
  const [sql, setSql] = useState(defaultSql ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<StepInfo[]>(INITIAL);

  const setStep = (key: StepInfo["key"], patch: Partial<StepInfo>) =>
    setSteps((s) => s.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const bundleBlob: Blob | null = file ?? defaultBundle ?? null;
  const bundleName = file?.name ?? defaultBundleName ?? "bundle.zip";

  const run = async () => {
    if (!workspaceId.trim()) { toast.error("Workspace ID লাগবে"); return; }
    if (!sql.trim() && !bundleBlob) { toast.error("SQL অথবা bundle অন্তত একটি লাগবে"); return; }

    setBusy(true);
    setSteps(INITIAL);

    // Step 1
    if (sql.trim()) {
      setStep("sql", { state: "running" });
      try {
        const r = await push({ data: { workspaceId: workspaceId.trim(), sql: sql.trim() } });
        if (r.ok) setStep("sql", { state: "ok", detail: `migration ${r.migrationId} · ${r.applied} statements` });
        else { setStep("sql", { state: "error", detail: `${r.error} (HTTP ${r.status})` }); setBusy(false); return; }
      } catch (e) {
        setStep("sql", { state: "error", detail: (e as Error).message }); setBusy(false); return;
      }
    } else {
      setStep("sql", { state: "ok", detail: "skipped (no SQL)" });
    }

    // Step 2
    if (bundleBlob) {
      setStep("upload", { state: "running" });
      try {
        const b64 = await blobToBase64(bundleBlob);
        const path = `${workspaceId.trim()}/${Date.now()}-${bundleName}`;
        const r = await upload({ data: { workspaceId: workspaceId.trim(), bucket: "deployments", path, contentBase64: b64 } });
        if (r.ok) setStep("upload", { state: "ok", detail: `${r.key} · ${(r.size / 1024).toFixed(1)} KB` });
        else { setStep("upload", { state: "error", detail: `${r.error} (HTTP ${r.status})` }); setBusy(false); return; }
      } catch (e) {
        setStep("upload", { state: "error", detail: (e as Error).message }); setBusy(false); return;
      }
    } else {
      setStep("upload", { state: "ok", detail: "skipped (no bundle)" });
    }

    // Step 3
    setStep("verify", { state: "running" });
    try {
      const r = await verify({ data: { workspaceId: workspaceId.trim() } });
      if (r.ok) {
        setStep("verify", { state: "ok", detail: r.latest ? `latest: ${r.latest.id} (${r.latest.status ?? "?"})` : "no deployments returned" });
        toast.success("Deploy সম্পন্ন ✓");
      } else {
        setStep("verify", { state: "error", detail: `${r.error} (HTTP ${r.status})` });
      }
    } catch (e) {
      setStep("verify", { state: "error", detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-primary/10 p-2 text-primary">
          <Rocket className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h3 className="font-semibold">Deploy to VPS</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Migration SQL push + bundle upload + verification — সব এক ক্লিকে VPS-এ পাঠান।
          </p>
        </div>
      </div>

      <div className="grid gap-3">
        <div>
          <label className="text-xs font-medium block mb-1">Workspace ID *</label>
          <input
            type="text"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            placeholder="ws_..."
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
            disabled={busy}
          />
        </div>

        <div>
          <label className="text-xs font-medium block mb-1">Migrations SQL (optional)</label>
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            placeholder="-- CREATE TABLE ..."
            rows={4}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono"
            disabled={busy}
          />
        </div>

        <div>
          <label className="text-xs font-medium block mb-1">Bundle ZIP (optional)</label>
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept=".zip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
              className="text-xs"
            />
            {!file && defaultBundle && (
              <span className="text-xs text-muted-foreground">
                <UploadIcon className="inline h-3 w-3 mr-1" />default: {defaultBundleName ?? "bundle.zip"}
              </span>
            )}
          </div>
        </div>
      </div>

      <button
        onClick={run}
        disabled={busy || !workspaceId.trim()}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
        {busy ? "Deploying…" : "Deploy to VPS"}
      </button>

      <ol className="space-y-1.5 text-sm">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-2">
            {s.state === "running" && <Loader2 className="h-4 w-4 animate-spin text-primary mt-0.5" />}
            {s.state === "ok" && <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" />}
            {s.state === "error" && <XCircle className="h-4 w-4 text-destructive mt-0.5" />}
            {s.state === "idle" && <Circle className="h-4 w-4 text-muted-foreground mt-0.5" />}
            <div className="flex-1">
              <div className={s.state === "error" ? "text-destructive" : ""}>{s.label}</div>
              {s.detail && <div className="text-[11px] text-muted-foreground font-mono">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
