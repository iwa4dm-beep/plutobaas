import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Shield, Play, Copy, Download, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, live } from "@/lib/pluto/live";
import { useWorkspace } from "@/lib/pluto/workspace-context";
import { downloadFile } from "@/lib/pluto/local-stack";
import {
  RBAC_TEMPLATES, generateRbacSql, generateRbacRollbackSql, generateRoleSeedSql,
  type PolicyAction, type RbacTemplate, type TableRule,
} from "@/lib/pluto/rbac-templates";

export const Route = createFileRoute("/dashboard/rbac-templates")({
  head: () => ({
    meta: [
      { title: "RBAC & RLS templates — Pluto BaaS" },
      { name: "description", content: "Pick a pre-built role model, tune the access matrix, and apply generated RLS policies straight to your project." },
      { property: "og:title", content: "RBAC & RLS templates — Pluto BaaS" },
      { property: "og:description", content: "Generate recursion-safe RLS policies and role tables, then apply them in one click." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RbacTemplatesPage,
});

const ACTIONS: PolicyAction[] = ["select", "insert", "update", "delete"];
const input = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";

function toggle(list: PolicyAction[], a: PolicyAction): PolicyAction[] {
  return list.includes(a) ? list.filter((x) => x !== a) : [...list, a];
}

function RbacTemplatesPage() {
  const { active } = useWorkspace();
  const [tplId, setTplId] = useState(RBAC_TEMPLATES[0].id);
  const [overrides, setOverrides] = useState<Record<string, TableRule[]>>({});
  const [seedEmail, setSeedEmail] = useState("");
  const [tab, setTab] = useState<"apply" | "rollback" | "seed">("apply");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const base = RBAC_TEMPLATES.find((t) => t.id === tplId)!;
  const tpl: RbacTemplate = useMemo(
    () => ({ ...base, tables: overrides[base.id] ?? base.tables }),
    [base, overrides],
  );

  const sql = useMemo(() => {
    if (tab === "rollback") return generateRbacRollbackSql(tpl);
    if (tab === "seed") return generateRoleSeedSql(tpl, seedEmail || "you@example.com");
    return generateRbacSql(tpl);
  }, [tpl, tab, seedEmail]);

  function patchTable(i: number, patch: Partial<TableRule>) {
    setOverrides((o) => ({
      ...o,
      [base.id]: (o[base.id] ?? base.tables).map((t, idx) => (idx === i ? { ...t, ...patch } : t)),
    }));
  }

  function addTable() {
    setOverrides((o) => ({
      ...o,
      [base.id]: [
        ...(o[base.id] ?? base.tables),
        { table: "new_table", ownerColumn: "user_id", publicRead: false, ownerActions: ["select", "insert", "update", "delete"], adminActions: ["select", "update", "delete"], roleActions: [] },
      ],
    }));
  }

  function removeTable(i: number) {
    setOverrides((o) => ({ ...o, [base.id]: (o[base.id] ?? base.tables).filter((_, idx) => idx !== i) }));
  }

  async function apply(dryRun: boolean) {
    setBusy(true); setMsg(null); setErr(null);
    try {
      if (!isLive()) throw new Error("Backend is not configured — download the SQL and run it from the SQL editor instead.");
      await live.sql.run(sql, { read_only: dryRun, workspace_id: active.id });
      setMsg(dryRun
        ? "Dry-run passed — the statements parse and are safe to apply."
        : "Policies applied to your project.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="RBAC & RLS templates"
        description="Roles live in their own table with a recursion-safe has_role() helper — never on profiles. Pick a model, tune the access matrix, dry-run, then apply."
      />

      {msg ? <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-600">{msg}</div> : null}
      {err ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{err}</div> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {RBAC_TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => setTplId(t.id)}
            className={`rounded-lg border p-3 text-left transition ${t.id === tplId ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}
          >
            <div className="flex items-center gap-2 text-sm font-semibold"><Shield className="h-4 w-4" /> {t.name}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t.summary}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {t.roles.map((r) => <span key={r} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono">{r}</span>)}
            </div>
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Access matrix</h2>
            <button onClick={addTable} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
              <Plus className="h-3 w-3" /> Table
            </button>
          </div>

          {tpl.tables.map((t, i) => (
            <div key={i} className="space-y-2 rounded-md border border-border/60 p-3">
              <div className="flex gap-2">
                <input className={input} value={t.table} onChange={(e) => patchTable(i, { table: e.target.value })} />
                <input className={input} value={t.ownerColumn} placeholder="owner column" onChange={(e) => patchTable(i, { ownerColumn: e.target.value })} />
                <button onClick={() => removeTable(i)} className="rounded-md border border-border px-2 text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={t.publicRead} onChange={(e) => patchTable(i, { publicRead: e.target.checked })} />
                Public (anon) read
              </label>

              <div className="space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">Owner can</span>
                <div className="flex flex-wrap gap-1">
                  {ACTIONS.map((a) => (
                    <button
                      key={a}
                      onClick={() => patchTable(i, { ownerActions: toggle(t.ownerActions, a) })}
                      className={`rounded px-2 py-0.5 text-[11px] font-mono ${t.ownerActions.includes(a) ? "bg-primary text-primary-foreground" : "border border-border"}`}
                    >{a}</button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">{tpl.roles[0]} can</span>
                <div className="flex flex-wrap gap-1">
                  {ACTIONS.map((a) => (
                    <button
                      key={a}
                      onClick={() => patchTable(i, { adminActions: toggle(t.adminActions, a) })}
                      className={`rounded px-2 py-0.5 text-[11px] font-mono ${t.adminActions.includes(a) ? "bg-primary text-primary-foreground" : "border border-border"}`}
                    >{a}</button>
                  ))}
                </div>
              </div>

              {t.roleActions.length ? (
                <div className="space-y-1">
                  {t.roleActions.map((g, gi) => (
                    <div key={g.role} className="space-y-1">
                      <span className="text-[11px] font-medium text-muted-foreground">{g.role} can</span>
                      <div className="flex flex-wrap gap-1">
                        {ACTIONS.map((a) => (
                          <button
                            key={a}
                            onClick={() => patchTable(i, {
                              roleActions: t.roleActions.map((x, xi) => xi === gi ? { ...x, actions: toggle(x.actions, a) } : x),
                            })}
                            className={`rounded px-2 py-0.5 text-[11px] font-mono ${g.actions.includes(a) ? "bg-primary text-primary-foreground" : "border border-border"}`}
                          >{a}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}

          <label className="block space-y-1 border-t border-border pt-3">
            <span className="text-xs font-medium text-muted-foreground">Seed the first {tpl.roles[0]} (email)</span>
            <input className={input} value={seedEmail} onChange={(e) => setSeedEmail(e.target.value)} placeholder="you@example.com" />
          </label>
        </section>

        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-1">
            {(["apply", "rollback", "seed"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-2.5 py-1 text-xs capitalize ${tab === t ? "bg-primary text-primary-foreground" : "border border-border hover:bg-muted"}`}
              >{t} SQL</button>
            ))}
            <div className="ml-auto flex gap-2">
              <button className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" onClick={() => navigator.clipboard.writeText(sql)}>
                <Copy className="h-3 w-3" /> Copy
              </button>
              <button className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" onClick={() => downloadFile(`rbac-${tpl.id}-${tab}.sql`, sql)}>
                <Download className="h-3 w-3" /> Download
              </button>
            </div>
          </div>

          <pre className="max-h-[520px] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">{sql}</pre>

          <div className="flex gap-2">
            <button onClick={() => apply(true)} disabled={busy} className="flex-1 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50">
              Dry-run
            </button>
            <button onClick={() => apply(false)} disabled={busy} className="flex flex-1 items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              <Play className="h-3.5 w-3.5" /> {busy ? "Working…" : "Apply to project"}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Applies in workspace <span className="font-mono">{active.slug}</span>. Every statement is idempotent, so re-running is safe.
          </p>
        </section>
      </div>
    </div>
  );
}
