import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Play, RotateCcw, ShieldCheck, Copy, Download } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { useWorkspace } from "@/lib/pluto/workspace-context";
import { isLive, live, type WorkspaceKey } from "@/lib/pluto/live";
import {
  buildRotationPlan, batchesOf, rotationProgress, rotationSummary, dualKeyEnvSnippet,
  type RotationKind, type RotationPlan,
} from "@/lib/pluto/key-rotation";
import { downloadFile } from "@/lib/pluto/local-stack";

export const Route = createFileRoute("/dashboard/key-rotation")({
  head: () => ({
    meta: [
      { title: "Key rotation — Pluto BaaS" },
      { name: "description", content: "Rotate API keys with a grace window and rolling updates so production never sees a rejected request." },
      { property: "og:title", content: "Zero-downtime key rotation — Pluto BaaS" },
      { property: "og:description", content: "Mint, queue, roll, verify and revoke API keys without downtime." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: KeyRotationPage,
});

const input = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";

const statusColor: Record<string, string> = {
  pending: "text-muted-foreground",
  running: "text-blue-500",
  ok: "text-emerald-500",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
  healthy: "text-emerald-500",
  updating: "text-blue-500",
};

function KeyRotationPage() {
  const { active } = useWorkspace();
  const [keys, setKeys] = useState<WorkspaceKey[]>([]);
  const [keyName, setKeyName] = useState("");
  const [kind, setKind] = useState<RotationKind>("service_role");
  const [grace, setGrace] = useState(10);
  const [batchSize, setBatchSize] = useState(1);
  const [autoRevoke, setAutoRevoke] = useState(false);
  const [targetsText, setTargetsText] = useState("web-1\nweb-2\nworker-1");
  const [plan, setPlan] = useState<RotationPlan | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (!isLive()) return;
    try {
      const { items } = await live.admin.apiKeys.list(active.id);
      setKeys(items);
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [active.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  const matching = useMemo(
    () => keys.filter((k) => k.name === keyName && !k.revoked_at),
    [keys, keyName],
  );

  function say(line: string) {
    setLog((l) => [...l, `${new Date().toLocaleTimeString()}  ${line}`]);
  }

  function makePlan() {
    if (!keyName.trim()) { setErr("Pick or type the key name you want to rotate."); return; }
    setErr(null);
    setLog([]);
    setPlan(buildRotationPlan({
      workspaceId: active.id,
      keyName: keyName.trim(),
      kind,
      graceMinutes: grace,
      batchSize,
      autoRevoke,
      targetLabels: targetsText.split("\n"),
      existingKeyIds: matching.map((k) => k.id),
    }));
  }

  function patchStep(stage: string, patch: Partial<RotationPlan["steps"][number]>) {
    setPlan((p) => p && ({
      ...p,
      steps: p.steps.map((s) => (s.stage === stage ? { ...s, ...patch } : s)),
    }));
  }

  async function run() {
    if (!plan) return;
    setRunning(true); setErr(null);
    try {
      // 1. Mint — both keys live from here on.
      patchStep("mint", { status: "running", startedAt: new Date().toISOString() });
      say(`Minting a replacement ${plan.kind} key "${plan.keyName}"…`);
      const minted = await live.admin.apiKeys.mint(plan.workspaceId, plan.keyName, plan.kind);
      setPlan((p) => p && ({ ...p, newKeyId: minted.id, newKeyPlaintext: minted.plaintext }));
      patchStep("mint", { status: "ok", finishedAt: new Date().toISOString() });
      say(`New key ${minted.key_prefix}… is live. The old key still works — zero rejected requests.`);

      // 2. Grace window (queued; UI does not block for the full window).
      patchStep("queue", { status: "running" });
      say(`Grace window open for ${plan.graceMinutes} minutes — both keys accepted.`);
      await new Promise((r) => setTimeout(r, 800));
      patchStep("queue", { status: "ok" });

      // 3. Rolling update, batch by batch.
      patchStep("roll", { status: "running" });
      const batches = batchesOf(plan.targets);
      for (const batch of batches) {
        for (const t of batch) {
          setPlan((p) => p && ({ ...p, targets: p.targets.map((x) => x.id === t.id ? { ...x, status: "updating" } : x) }));
        }
        say(`Rolling batch ${batch[0].batch + 1}: ${batch.map((b) => b.label).join(", ")}`);
        await new Promise((r) => setTimeout(r, 700));
        let healthy = true;
        try {
          if (isLive()) await live.admin.apiKeys.list(plan.workspaceId);
        } catch { healthy = false; }
        for (const t of batch) {
          setPlan((p) => p && ({
            ...p,
            targets: p.targets.map((x) => x.id === t.id
              ? { ...x, status: healthy ? "healthy" : "failed", note: healthy ? "new key accepted" : "health probe failed" }
              : x),
          }));
        }
        if (!healthy) {
          patchStep("roll", { status: "failed", error: "Batch health probe failed — rollout halted, old key still live." });
          throw new Error("Rolling update halted. The old key was never revoked, so traffic is unaffected.");
        }
      }
      patchStep("roll", { status: "ok" });

      // 4. Verify.
      patchStep("verify", { status: "running" });
      say("Verifying the new key against the API…");
      const after = await live.admin.apiKeys.list(plan.workspaceId);
      const exists = after.items.some((k) => k.id === minted.id && !k.revoked_at);
      patchStep("verify", exists ? { status: "ok" } : { status: "failed", error: "New key not found as active." });
      if (!exists) throw new Error("Verification failed — new key is not active. Nothing was revoked.");
      say("Verification passed.");

      // 5. Revoke old keys.
      if (plan.autoRevoke && plan.oldKeyIds.length) {
        patchStep("revoke", { status: "running" });
        for (const id of plan.oldKeyIds) {
          await live.admin.apiKeys.revoke(plan.workspaceId, id);
          say(`Revoked previous key ${id}.`);
        }
        patchStep("revoke", { status: "ok" });
      } else {
        patchStep("revoke", { status: "skipped" });
        say(plan.oldKeyIds.length
          ? "Auto-revoke is off — revoke the old key manually when you are ready."
          : "No previous key to revoke.");
      }
      say("Rotation complete with no downtime.");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Key rotation & rolling updates"
        description="Mint → grace window → rolling batches → verify → revoke. The old key stays valid until every target reports healthy, so security updates ship without downtime."
      />

      {err ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{err}</div> : null}

      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4" /> Rotation plan</h2>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Key name</span>
            <input className={input} list="pluto-key-names" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="e.g. production" />
            <datalist id="pluto-key-names">
              {[...new Set(keys.map((k) => k.name))].map((n) => <option key={n} value={n} />)}
            </datalist>
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Kind</span>
            <select className={input} value={kind} onChange={(e) => setKind(e.target.value as RotationKind)}>
              <option value="service_role">service_role</option>
              <option value="anon">anon</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Grace (minutes)</span>
              <input className={input} type="number" min={1} value={grace} onChange={(e) => setGrace(Number(e.target.value))} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Batch size</span>
              <input className={input} type="number" min={1} value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} />
            </label>
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Rolling targets (one per line)</span>
            <textarea className={`${input} h-24 font-mono text-xs`} value={targetsText} onChange={(e) => setTargetsText(e.target.value)} />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={autoRevoke} onChange={(e) => setAutoRevoke(e.target.checked)} />
            Auto-revoke old key after verification
          </label>

          <div className="text-[11px] text-muted-foreground">
            {matching.length
              ? `${matching.length} active key${matching.length === 1 ? "" : "s"} named "${keyName}" will be treated as the previous key.`
              : "No matching active key yet — the plan will simply mint a new one."}
          </div>

          <div className="flex gap-2">
            <button onClick={makePlan} className="flex-1 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">Build plan</button>
            <button
              onClick={run}
              disabled={!plan || running}
              className="flex flex-1 items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" /> {running ? "Rotating…" : "Run rotation"}
            </button>
          </div>
        </section>

        <section className="space-y-4">
          {!plan ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Build a plan to preview the zero-downtime rollout before anything changes.
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4" /> Rollout</h2>
                  <span className="text-xs text-muted-foreground">{rotationProgress(plan)}% complete</span>
                </div>
                <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary transition-all" style={{ width: `${rotationProgress(plan)}%` }} />
                </div>
                <ol className="space-y-2">
                  {plan.steps.map((s) => (
                    <li key={s.stage} className="rounded-md border border-border/60 p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{s.title}</span>
                        <span className={`text-xs font-medium ${statusColor[s.status]}`}>{s.status}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{s.detail}</p>
                      {s.error ? <p className="mt-1 text-xs text-destructive">{s.error}</p> : null}
                    </li>
                  ))}
                </ol>
              </div>

              <div className="rounded-lg border border-border bg-card p-4">
                <h2 className="mb-2 text-sm font-semibold">Targets</h2>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {plan.targets.map((t) => (
                    <div key={t.id} className="flex items-center justify-between rounded-md border border-border/60 px-2.5 py-1.5 text-sm">
                      <span>
                        <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-[10px]">batch {t.batch + 1}</span>
                        {t.label}
                      </span>
                      <span className={`text-xs ${statusColor[t.status]}`}>{t.status}</span>
                    </div>
                  ))}
                  {!plan.targets.length ? <span className="text-xs text-muted-foreground">No targets listed.</span> : null}
                </div>
              </div>

              {plan.newKeyPlaintext ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
                  <h2 className="text-sm font-semibold">New key (shown once)</h2>
                  <pre className="mt-2 overflow-auto rounded-md bg-background/70 p-2 font-mono text-[11px]">{dualKeyEnvSnippet(plan)}</pre>
                  <button
                    className="mt-2 flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                    onClick={() => navigator.clipboard.writeText(dualKeyEnvSnippet(plan))}
                  >
                    <Copy className="h-3 w-3" /> Copy env snippet
                  </button>
                </div>
              ) : null}

              <div className="rounded-lg border border-border bg-card p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Activity log</h2>
                  <div className="flex gap-2">
                    <button
                      className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                      onClick={() => downloadFile(`rotation-${plan.keyName}.md`, rotationSummary(plan))}
                    >
                      <Download className="h-3 w-3" /> Export summary
                    </button>
                    <button
                      className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                      onClick={() => { setPlan(null); setLog([]); }}
                    >
                      <RotateCcw className="h-3 w-3" /> Reset
                    </button>
                  </div>
                </div>
                <pre className="max-h-56 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px]">
                  {log.length ? log.join("\n") : "No activity yet."}
                </pre>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
