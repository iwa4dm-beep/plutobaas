// Permission Checker — probes storage / auth / backups tables against
// anon and authenticated roles to reveal which read/write actions RLS
// blocks. Uses only public HTTP endpoints (no service key required).
//
// Method: for each (role, table, action) triple we perform the minimal
// call and classify the response as allowed / blocked / server-error.
import { useCallback, useState } from "react";
import { Loader2, Play, ShieldCheck, Download } from "lucide-react";
import { buildReport, downloadReportHtml, downloadReportJson, type ReportStep } from "@/lib/pluto/connect-utils";

type Verdict = "idle" | "running" | "allowed" | "blocked" | "error";

type Probe = {
  role: "anon" | "authenticated";
  target: string;        // logical table / resource
  action: "read" | "write" | "delete";
  path: string;          // fetch path relative to apiBase
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
};

const PROBES: Probe[] = [
  // storage.buckets — list is usually anon-readable
  { role: "anon",          target: "storage.buckets", action: "read",   path: "/v1/storage/buckets",                 method: "GET" },
  { role: "authenticated", target: "storage.buckets", action: "read",   path: "/v1/storage/buckets",                 method: "GET" },
  { role: "authenticated", target: "storage.buckets", action: "write",  path: "/v1/storage/buckets",                 method: "POST", body: { name: `probe-${Date.now()}`, public: false } },

  // storage.objects (via avatars)
  { role: "anon",          target: "storage.objects/avatars",   action: "read",  path: "/v1/storage/object/public/avatars/__probe.txt", method: "GET" },
  { role: "authenticated", target: "storage.objects/avatars",   action: "write", path: `/v1/storage/object/avatars/__probe-${Date.now()}.txt`, method: "POST", body: "probe" },
  { role: "authenticated", target: "storage.objects/avatars",   action: "delete",path: "/v1/storage/object/avatars/__probe.txt", method: "DELETE" },

  // auth.users — should ALWAYS be blocked from client (server-only)
  { role: "anon",          target: "auth.users",     action: "read",   path: "/v1/rest/users?select=id&limit=1",    method: "GET" },
  { role: "authenticated", target: "auth.users",     action: "read",   path: "/v1/rest/users?select=id&limit=1",    method: "GET" },

  // profiles — RLS: own row only
  { role: "anon",          target: "public.profiles",action: "read",   path: "/v1/rest/profiles?select=id&limit=1", method: "GET" },
  { role: "authenticated", target: "public.profiles",action: "read",   path: "/v1/rest/profiles?select=id&limit=1", method: "GET" },
  { role: "authenticated", target: "public.profiles",action: "write",  path: "/v1/rest/profiles",                    method: "POST", body: { username: `probe-${Date.now()}` } },

  // backups — admin-only endpoint
  { role: "anon",          target: "admin/backups",  action: "read",   path: "/v1/admin/backups",                    method: "GET" },
  { role: "authenticated", target: "admin/backups",  action: "read",   path: "/v1/admin/backups",                    method: "GET" },
  { role: "authenticated", target: "admin/backups",  action: "write",  path: "/v1/admin/backups",                    method: "POST", body: { label: `probe-${Date.now()}` } },
];

type ProbeResult = Probe & { verdict: Verdict; status?: number; ms?: number; detail?: string };

function classify(status: number): Verdict {
  if (status === 0) return "error";
  if (status >= 200 && status < 300) return "allowed";
  if (status === 401 || status === 403) return "blocked";
  if (status === 404) return "blocked"; // no row visible via RLS often surfaces as 404
  if (status === 406) return "blocked"; // RLS on rest
  if (status >= 500) return "error";
  return "blocked";
}

function badgeCls(v: Verdict): string {
  return v === "allowed" ? "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30"
    : v === "blocked"    ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30"
    : v === "error"      ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30"
    : v === "running"    ? "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30"
    : "bg-muted text-muted-foreground border-border/50";
}

export function PermissionChecker({ apiBase }: { apiBase: string }) {
  const [anonKey, setAnonKey] = useState("");
  const [userToken, setUserToken] = useState("");
  const [rows, setRows] = useState<ProbeResult[]>(PROBES.map((p) => ({ ...p, verdict: "idle" })));
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    const next: ProbeResult[] = PROBES.map((p) => ({ ...p, verdict: "running" }));
    setRows(next);
    for (let i = 0; i < next.length; i++) {
      const p = next[i];
      const headers: Record<string, string> = {};
      if (anonKey) headers.apikey = anonKey;
      if (p.role === "authenticated") {
        if (userToken) headers.authorization = `Bearer ${userToken}`;
        else if (anonKey) headers.authorization = `Bearer ${anonKey}`;
      }
      const init: RequestInit = { method: p.method, headers };
      if (p.body !== undefined) {
        if (typeof p.body === "string") { init.body = p.body; headers["content-type"] = "text/plain"; }
        else { init.body = JSON.stringify(p.body); headers["content-type"] = "application/json"; }
      }
      const start = performance.now();
      let status = 0, text = "";
      try {
        const r = await fetch(apiBase + p.path, init);
        status = r.status;
        text = (await r.text()).slice(0, 200);
      } catch (e) {
        text = e instanceof Error ? e.message : String(e);
      }
      const ms = Math.round(performance.now() - start);
      next[i] = { ...p, verdict: classify(status), status, ms, detail: text };
      setRows([...next]);
    }
    setRunning(false);
  }, [apiBase, anonKey, userToken]);

  const exportSteps: ReportStep[] = rows.map((r, idx) => ({
    key: `${r.role}:${r.target}:${r.action}`,
    label: `${r.role} → ${r.action.toUpperCase()} ${r.target}`,
    status: r.verdict === "allowed" ? "ok" : r.verdict === "blocked" ? "skipped" : r.verdict === "error" ? "fail" : "idle",
    ms: r.ms,
    detail: `${r.method} ${r.path} → HTTP ${r.status ?? 0}`,
    error: r.detail,
    attempts: 1,
    // idx to keep stable order
    ...(idx === -1 ? {} : {}),
  }));

  const doExport = (kind: "json" | "html") => {
    const report = buildReport({ tool: "permission-check", apiBase, steps: exportSteps });
    (kind === "json" ? downloadReportJson : downloadReportHtml)(report);
  };

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <input type="password" placeholder="pk_anon_… (required)" value={anonKey}
          onChange={(e) => setAnonKey(e.target.value)}
          className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs font-mono" />
        <input type="password" placeholder="user access_token (optional — enables authed row)" value={userToken}
          onChange={(e) => setUserToken(e.target.value)}
          className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs font-mono" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button onClick={run} disabled={running || !anonKey}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          Probe RLS/policies
        </button>
        <button onClick={() => doExport("json")} disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
          <Download className="h-3.5 w-3.5" /> JSON
        </button>
        <button onClick={() => doExport("html")} disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
          <Download className="h-3.5 w-3.5" /> HTML
        </button>
        <span className="text-[11px] text-muted-foreground">
          allowed = call succeeded · blocked = RLS/policy denied (401/403/404/406) · error = server/network
        </span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5">Role</th>
              <th className="px-2 py-1.5">Resource</th>
              <th className="px-2 py-1.5">Action</th>
              <th className="px-2 py-1.5">Verdict</th>
              <th className="px-2 py-1.5">HTTP</th>
              <th className="px-2 py-1.5 text-right">Latency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-border/40 align-top">
                <td className="px-2 py-1.5 font-mono">{r.role}</td>
                <td className="px-2 py-1.5 font-mono">{r.target}</td>
                <td className="px-2 py-1.5 font-mono">{r.action.toUpperCase()}</td>
                <td className="px-2 py-1.5">
                  <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold ${badgeCls(r.verdict)}`}>
                    {r.verdict}
                  </span>
                </td>
                <td className="px-2 py-1.5 font-mono">{r.status ?? "-"}</td>
                <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{r.ms != null ? `${r.ms}ms` : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Probes send tiny throw-away payloads. Any created row/object stays until you delete it; use short-lived probe accounts.
      </p>
    </div>
  );
}
