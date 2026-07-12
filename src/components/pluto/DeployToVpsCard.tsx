// Phase 3 UI: Deploy migrations SQL + bundle to VPS with:
//  - live per-step logs (raw request/response, latency, HTTP status)
//  - one-click retry per step (sql / upload / verify) after failure
//  - auto-start via `autoStartTrigger` prop (Provision → auto-deploy flow)
//  - deployment history write on completion
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Rocket, Loader2, CheckCircle2, XCircle, Circle, Upload as UploadIcon,
  RotateCw, ChevronDown, ChevronRight,
} from "lucide-react";
import {
  pushMigrations, uploadBundle, verifyDeploy,
  type StepDebug,
} from "@/lib/pluto/vps-deployer.functions";
import { saveHistoryEntry, type HistoryStep } from "@/lib/pluto/deploy-history";

type StepKey = "sql" | "upload" | "verify";
type StepState = "idle" | "running" | "ok" | "error" | "skipped";
type StepInfo = {
  key: StepKey;
  label: string;
  state: StepState;
  detail?: string;
  debug: StepDebug | null;
};

const INITIAL: StepInfo[] = [
  { key: "sql", label: "Push migrations SQL", state: "idle", debug: null },
  { key: "upload", label: "Upload bundle to storage", state: "idle", debug: null },
  { key: "verify", label: "Verify latest deployment", state: "idle", debug: null },
];

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
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
  defaultWorkspaceId,
  autoStartTrigger,
}: {
  defaultSql?: string;
  defaultBundle?: Blob | null;
  defaultBundleName?: string;
  defaultWorkspaceId?: string;
  /** When this value changes to a truthy string, deployment auto-starts with that workspaceId. */
  autoStartTrigger?: string | null;
}) {
  const push = useServerFn(pushMigrations);
  const upload = useServerFn(uploadBundle);
  const verify = useServerFn(verifyDeploy);

  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId ?? "");
  const [sql, setSql] = useState(defaultSql ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<StepKey | "all" | null>(null);
  const [steps, setSteps] = useState<StepInfo[]>(INITIAL);
  const [expanded, setExpanded] = useState<Record<StepKey, boolean>>({ sql: false, upload: false, verify: false });
  const historyWritten = useRef<string | null>(null);

  const bundleBlob: Blob | null = file ?? defaultBundle ?? null;
  const bundleName = file?.name ?? defaultBundleName ?? "bundle.zip";

  const setStep = useCallback(
    (key: StepKey, patch: Partial<StepInfo>) =>
      setSteps((s) => s.map((x) => (x.key === key ? { ...x, ...patch } : x))),
    [],
  );

  // ---- Individual step runners (each is retry-able on its own) ----
  const runSql = useCallback(async (wsId: string): Promise<boolean> => {
    if (!sql.trim()) { setStep("sql", { state: "skipped", detail: "no SQL provided", debug: null }); return true; }
    setStep("sql", { state: "running", detail: undefined, debug: null });
    try {
      const r = await push({ data: { workspaceId: wsId, sql: sql.trim() } });
      if (r.ok) { setStep("sql", { state: "ok", detail: `migration ${r.migrationId || "?"} · ${r.applied} statements`, debug: r.debug }); return true; }
      setStep("sql", { state: "error", detail: `${r.error} (HTTP ${r.status})`, debug: r.debug }); return false;
    } catch (e) {
      setStep("sql", { state: "error", detail: (e as Error).message, debug: null }); return false;
    }
  }, [sql, push, setStep]);

  const runUpload = useCallback(async (wsId: string): Promise<boolean> => {
    if (!bundleBlob) { setStep("upload", { state: "skipped", detail: "no bundle provided", debug: null }); return true; }
    setStep("upload", { state: "running", detail: undefined, debug: null });
    try {
      const b64 = await blobToBase64(bundleBlob);
      const path = `${wsId}/${Date.now()}-${bundleName}`;
      const r = await upload({ data: { workspaceId: wsId, bucket: "deployments", path, contentBase64: b64 } });
      if (r.ok) { setStep("upload", { state: "ok", detail: `${r.key} · ${(r.size / 1024).toFixed(1)} KB`, debug: r.debug }); return true; }
      setStep("upload", { state: "error", detail: `${r.error} (HTTP ${r.status})`, debug: r.debug }); return false;
    } catch (e) {
      setStep("upload", { state: "error", detail: (e as Error).message, debug: null }); return false;
    }
  }, [bundleBlob, bundleName, upload, setStep]);

  const runVerify = useCallback(async (wsId: string): Promise<boolean> => {
    setStep("verify", { state: "running", detail: undefined, debug: null });
    try {
      const r = await verify({ data: { workspaceId: wsId } });
      if (r.ok) {
        setStep("verify", {
          state: "ok",
          detail: r.latest ? `latest: ${r.latest.id} (${r.latest.status ?? "?"})` : "no deployments returned",
          debug: r.debug,
        });
        return true;
      }
      setStep("verify", { state: "error", detail: `${r.error} (HTTP ${r.status})`, debug: r.debug }); return false;
    } catch (e) {
      setStep("verify", { state: "error", detail: (e as Error).message, debug: null }); return false;
    }
  }, [verify, setStep]);

  const persistHistory = useCallback((wsId: string, currentSteps: StepInfo[]) => {
    const id = `dep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    if (historyWritten.current === id) return;
    historyWritten.current = id;
    const finished = currentSteps.every((s) => s.state === "ok" || s.state === "error" || s.state === "skipped");
    if (!finished) return;
    const overallOk = currentSteps.every((s) => s.state === "ok" || s.state === "skipped");
    const historySteps: HistoryStep[] = currentSteps.map((s) => ({
      key: s.key,
      label: s.label,
      state: s.state === "ok" ? "ok" : s.state === "skipped" ? "skipped" : "error",
      detail: s.detail,
      debug: s.debug,
    }));
    saveHistoryEntry({ id, timestamp: Date.now(), workspaceId: wsId, overallOk, steps: historySteps });
  }, []);

  const runAll = useCallback(async (wsIdOverride?: string) => {
    const wsId = (wsIdOverride ?? workspaceId).trim();
    if (!wsId) { toast.error("Workspace ID লাগবে"); return; }
    if (wsIdOverride && wsIdOverride !== workspaceId) setWorkspaceId(wsId);
    setBusy("all");
    setSteps(INITIAL);
    historyWritten.current = null;
    const ok1 = await runSql(wsId);
    const ok2 = ok1 ? await runUpload(wsId) : false;
    const ok3 = ok1 && ok2 ? await runVerify(wsId) : false;
    setBusy(null);
    setSteps((cur) => { persistHistory(wsId, cur); return cur; });
    if (ok1 && ok2 && ok3) toast.success("Deploy সম্পন্ন ✓");
    else toast.error("Deploy failed — retry individual steps below");
  }, [workspaceId, runSql, runUpload, runVerify, persistHistory]);

  const retryStep = useCallback(async (key: StepKey) => {
    const wsId = workspaceId.trim();
    if (!wsId) { toast.error("Workspace ID লাগবে"); return; }
    setBusy(key);
    const ok = key === "sql" ? await runSql(wsId) : key === "upload" ? await runUpload(wsId) : await runVerify(wsId);
    setBusy(null);
    setSteps((cur) => { persistHistory(wsId, cur); return cur; });
    if (ok) toast.success(`${key} retried ✓`); else toast.error(`${key} retry failed`);
  }, [workspaceId, runSql, runUpload, runVerify, persistHistory]);

  // ---- Auto-start hook ----
  const lastAuto = useRef<string | null>(null);
  useEffect(() => {
    if (autoStartTrigger && autoStartTrigger !== lastAuto.current && busy === null) {
      lastAuto.current = autoStartTrigger;
      void runAll(autoStartTrigger);
    }
  }, [autoStartTrigger, busy, runAll]);

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-primary/10 p-2 text-primary">
          <Rocket className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h3 className="font-semibold">Deploy to VPS</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Migration SQL + bundle upload + verification — per-step retry এবং live raw logs সহ।
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
            disabled={busy !== null}
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
            disabled={busy !== null}
          />
        </div>

        <div>
          <label className="text-xs font-medium block mb-1">Bundle ZIP (optional)</label>
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept=".zip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy !== null}
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
        onClick={() => runAll()}
        disabled={busy !== null || !workspaceId.trim()}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {busy === "all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
        {busy === "all" ? "Deploying…" : "Deploy to VPS"}
      </button>

      <ol className="space-y-2 text-sm">
        {steps.map((s) => {
          const isBusy = busy === s.key || busy === "all" && s.state === "running";
          const canRetry = s.state === "error" && busy === null;
          const canExpand = s.debug !== null;
          return (
            <li key={s.key} className="rounded-md border border-border bg-background/40">
              <div className="flex items-start gap-2 p-2">
                {s.state === "running" && <Loader2 className="h-4 w-4 animate-spin text-primary mt-0.5" />}
                {s.state === "ok" && <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" />}
                {s.state === "error" && <XCircle className="h-4 w-4 text-destructive mt-0.5" />}
                {s.state === "skipped" && <Circle className="h-4 w-4 text-muted-foreground mt-0.5" />}
                {s.state === "idle" && <Circle className="h-4 w-4 text-muted-foreground mt-0.5" />}
                <div className="flex-1 min-w-0">
                  <div className={`flex items-center gap-2 ${s.state === "error" ? "text-destructive" : ""}`}>
                    <span>{s.label}</span>
                    {s.debug && (
                      <span className="text-[10px] text-muted-foreground font-mono">
                        HTTP {s.debug.status} · {s.debug.latencyMs}ms
                      </span>
                    )}
                  </div>
                  {s.detail && <div className="text-[11px] text-muted-foreground font-mono break-all">{s.detail}</div>}
                </div>
                {canExpand && (
                  <button
                    onClick={() => setExpanded((e) => ({ ...e, [s.key]: !e[s.key] }))}
                    className="rounded p-1 hover:bg-accent"
                    aria-label="Toggle raw log"
                  >
                    {expanded[s.key] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                )}
                {canRetry && (
                  <button
                    onClick={() => retryStep(s.key)}
                    disabled={isBusy}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                  >
                    {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                    Retry
                  </button>
                )}
              </div>
              {canExpand && expanded[s.key] && s.debug && (
                <div className="border-t border-border bg-muted/40 px-3 py-2 space-y-2 text-[11px] font-mono">
                  <div className="text-muted-foreground">
                    <span className="text-foreground font-semibold">{s.debug.method}</span> {s.debug.url}
                  </div>
                  {s.debug.reqBodyPreview && (
                    <details open>
                      <summary className="cursor-pointer text-muted-foreground">Request body</summary>
                      <pre className="mt-1 whitespace-pre-wrap break-all">{s.debug.reqBodyPreview}</pre>
                    </details>
                  )}
                  <details open>
                    <summary className="cursor-pointer text-muted-foreground">Response body</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-all">{s.debug.resBodyPreview}</pre>
                  </details>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
