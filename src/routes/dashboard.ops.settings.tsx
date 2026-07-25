import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, CheckCircle2, Download, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";
import {
  approveOpsRequest, downloadOpsReport, executeOpsRequest, getOpsConfig,
  listOpsApprovals, listOpsReports, rejectOpsRequest, setOpsConfig,
  type OpsApprovalEntry, type OpsEnv, type OpsEnvConfig, type OpsReportEntry,
} from "@/lib/pluto/vps-ops.functions";

export const Route = createFileRoute("/dashboard/ops/settings")({
  component: SettingsPage,
  validateSearch: (s: Record<string, unknown>) => ({
    env: (s.env === "dev" || s.env === "staging" || s.env === "prod" ? s.env : "prod") as OpsEnv,
  }),
  head: () => ({
    meta: [
      { title: "Ops Settings — Pluto BaaS" },
      { name: "description", content: "Webhooks, retention, approvals and downloadable reports for VPS operations." },
      { property: "og:title", content: "Ops Settings — Pluto BaaS" },
      { property: "og:description", content: "Configure notifications, retention, and approvals for Pluto BaaS operations." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function SettingsPage() {
  return (
    <TraceAccessGate permission="manage">
      <SettingsPageInner />
    </TraceAccessGate>
  );
}

function SettingsPageInner() {
  const { env } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/dashboard/ops" search={{ env }} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Operations
        </Link>
      </div>
      <PageHeader title="Ops settings" description="Webhooks, retention, prod approvals, and downloadable reports." />

      <div className="flex flex-wrap items-center gap-2">
        {(["dev", "staging", "prod"] as OpsEnv[]).map((e) => (
          <button
            key={e}
            className={`rounded-md border px-3 py-1 text-sm ${e === env ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
            onClick={() => navigate({ search: { env: e } })}
          >
            {e}
          </button>
        ))}
      </div>

      <ConfigCard env={env} />
      <ApprovalsCard env={env} />
      <ReportsCard env={env} />
    </div>
  );
}

/* -------- Config -------- */
function ConfigCard({ env }: { env: OpsEnv }) {
  const get = useServerFn(getOpsConfig);
  const put = useServerFn(setOpsConfig);
  const [cfg, setCfg] = useState<OpsEnvConfig>({ webhookUrl: "", retentionDays: 0, retentionCount: 0, approverEmails: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [approversInput, setApproversInput] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await get({ data: { env } });
      if (r.ok && r.config) {
        setCfg(r.config);
        setApproversInput(r.config.approverEmails.join(", "));
      }
    } finally { setLoading(false); }
  }, [env, get]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const approverEmails = approversInput.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const r = await put({ data: { env, webhookUrl: cfg.webhookUrl, retentionDays: cfg.retentionDays, retentionCount: cfg.retentionCount, approverEmails } });
      if (r.ok && r.config) { setCfg(r.config); setMsg({ ok: true, text: "Saved" }); }
      else setMsg({ ok: false, text: r.error || `HTTP ${r.status}` });
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    finally { setSaving(false); }
  };

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Notifications & retention · {env}</h2>
        <button onClick={load} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <RefreshCw className="size-3" /> Reload
        </button>
      </div>
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 md:col-span-2">
            <span className="text-sm font-medium">Webhook URL</span>
            <input
              type="url" placeholder="https://hooks.example.com/pluto-ops"
              value={cfg.webhookUrl}
              onChange={(e) => setCfg({ ...cfg, webhookUrl: e.target.value })}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            <span className="block text-xs text-muted-foreground">Receives JSON POSTs for every migration, rollout, restart, backup, and approval event.</span>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">Retention (days)</span>
            <input type="number" min={0} max={3650} value={cfg.retentionDays}
              onChange={(e) => setCfg({ ...cfg, retentionDays: Math.max(0, Number(e.target.value) || 0) })}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
            <span className="block text-xs text-muted-foreground">0 = keep forever</span>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">Retention (count)</span>
            <input type="number" min={0} max={1000} value={cfg.retentionCount}
              onChange={(e) => setCfg({ ...cfg, retentionCount: Math.max(0, Number(e.target.value) || 0) })}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
            <span className="block text-xs text-muted-foreground">Keep newest N dumps (0 = unlimited)</span>
          </label>
          <label className="space-y-1 md:col-span-2">
            <span className="text-sm font-medium">Approver emails (prod)</span>
            <textarea rows={2} value={approversInput} onChange={(e) => setApproversInput(e.target.value)}
              placeholder="alice@example.com, bob@example.com"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
            <span className="block text-xs text-muted-foreground">Comma or space separated. Empty = any admin can approve (still cannot self-approve).</span>
          </label>
          <div className="md:col-span-2 flex items-center gap-3">
            <button onClick={save} disabled={saving}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {saving ? "Saving…" : "Save"}
            </button>
            {msg ? (
              <span className={`inline-flex items-center gap-1 text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`}>
                {msg.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />} {msg.text}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

/* -------- Approvals -------- */
function ApprovalsCard({ env }: { env: OpsEnv }) {
  const list = useServerFn(listOpsApprovals);
  const approve = useServerFn(approveOpsRequest);
  const reject = useServerFn(rejectOpsRequest);
  const execute = useServerFn(executeOpsRequest);
  const [rows, setRows] = useState<OpsApprovalEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await list({ data: { env, limit: 50 } });
      setRows(r.entries || []);
    } finally { setLoading(false); }
  }, [env, list]);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (id: string, kind: "approve" | "reject" | "execute") => {
    if (env !== "prod") { setMsg("Approvals are only for prod"); return; }
    setBusyId(id); setMsg(null);
    try {
      const r = kind === "approve" ? await approve({ data: { env: "prod", id } })
              : kind === "reject" ? await reject({ data: { env: "prod", id } })
              : await execute({ data: { env: "prod", id } });
      if (!r.ok) setMsg(r.error || "Action failed");
      await refresh();
    } finally { setBusyId(null); }
  };

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="inline-flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="size-4" /> Approvals · {env}
        </h2>
        <button onClick={refresh} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <RefreshCw className="size-3" /> Reload
        </button>
      </div>
      {env !== "prod" ? (
        <p className="text-sm text-muted-foreground">Approvals apply to <strong>prod</strong> destructive actions only.</p>
      ) : loading ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No approval requests yet.</p>
      ) : (
        <div className="space-y-2">
          {msg ? <p className="text-sm text-red-600">{msg}</p> : null}
          {rows.map((r) => (
            <div key={r.id} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{r.id.slice(0, 8)}</span>
                <span className="rounded bg-muted px-2 py-0.5 text-xs">{r.action}</span>
                <StatusBadge status={r.status} />
                <span className="text-xs text-muted-foreground">by {r.requesterEmail || r.requesterUserId || "?"}</span>
                <span className="ml-auto text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
              </div>
              <p className="mt-1 text-sm">{r.reason}</p>
              {r.status === "pending" ? (
                <div className="mt-2 flex gap-2">
                  <button disabled={busyId === r.id} onClick={() => act(r.id, "approve")}
                    className="rounded-md bg-emerald-600 px-3 py-1 text-xs text-white disabled:opacity-50">Approve</button>
                  <button disabled={busyId === r.id} onClick={() => act(r.id, "reject")}
                    className="rounded-md bg-red-600 px-3 py-1 text-xs text-white disabled:opacity-50">Reject</button>
                </div>
              ) : r.status === "approved" ? (
                <div className="mt-2 flex gap-2">
                  <button disabled={busyId === r.id} onClick={() => act(r.id, "execute")}
                    className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50">Execute</button>
                </div>
              ) : r.executionResult ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Execution output (exit {r.executionResult.exitCode})</summary>
                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{r.executionResult.tail}</pre>
                </details>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: OpsApprovalEntry["status"] }) {
  const map: Record<OpsApprovalEntry["status"], string> = {
    pending: "bg-amber-100 text-amber-800",
    approved: "bg-blue-100 text-blue-800",
    executing: "bg-blue-100 text-blue-800",
    executed: "bg-emerald-100 text-emerald-800",
    rejected: "bg-red-100 text-red-800",
    failed: "bg-red-100 text-red-800",
    expired: "bg-muted text-muted-foreground",
  };
  return <span className={`rounded px-2 py-0.5 text-xs ${map[status]}`}>{status}</span>;
}

/* -------- Reports -------- */
function ReportsCard({ env }: { env: OpsEnv }) {
  const list = useServerFn(listOpsReports);
  const dl = useServerFn(downloadOpsReport);
  const [rows, setRows] = useState<OpsReportEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await list({ data: { env, limit: 50 } });
      setRows(r.entries || []);
    } finally { setLoading(false); }
  }, [env, list]);

  useEffect(() => { void refresh(); }, [refresh]);

  const download = async (id: string, format: "md" | "json") => {
    setBusyId(id + format);
    try {
      const r = await dl({ data: { env, id, format } });
      if (!r.ok) return;
      const blob = new Blob([r.content], { type: r.contentType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = r.filename; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
    } finally { setBusyId(null); }
  };

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Migration reports · {env}</h2>
        <button onClick={refresh} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <RefreshCw className="size-3" /> Reload
        </button>
      </div>
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reports yet. Run plan / dry-run / apply from Operations to generate one.</p>
      ) : (
        <div className="divide-y">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="rounded bg-muted px-2 py-0.5 text-xs">{r.kind}</span>
              <span className={`rounded px-2 py-0.5 text-xs ${r.outcome === "ok" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>{r.outcome}</span>
              <span className="text-xs text-muted-foreground">{r.affected?.length ?? 0} objects · pending {r.pending ?? 0}</span>
              <span className="ml-auto text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
              <button disabled={busyId === r.id + "md"} onClick={() => download(r.id, "md")}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">
                <Download className="size-3" /> .md
              </button>
              <button disabled={busyId === r.id + "json"} onClick={() => download(r.id, "json")}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">
                <Download className="size-3" /> .json
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
