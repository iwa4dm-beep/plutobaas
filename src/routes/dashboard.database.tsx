import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Play, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { pluto, type PlutoTable } from "@/lib/pluto/client";

export const Route = createFileRoute("/dashboard/database")({
  component: DatabasePage,
});

function DatabasePage() {
  const [tables, setTables] = useState<PlutoTable[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [sql, setSql] = useState("select now();");
  const [sqlResult, setSqlResult] = useState<{ columns: string[]; rows: unknown[][] } | null>(null);

  useEffect(() => {
    pluto.db.listTables().then((t) => {
      setTables(t);
      if (t[0]) setActive(t[0].name);
    });
  }, []);

  useEffect(() => {
    if (active) pluto.db.listRows(active).then(setRows);
  }, [active]);

  const activeTable = tables.find((t) => t.name === active);

  async function onDelete(id: string) {
    if (!active) return;
    await pluto.db.deleteRow(active, id);
    setRows(await pluto.db.listRows(active));
  }

  async function runSql() {
    setSqlResult(await pluto.db.runSql(sql));
  }

  return (
    <div>
      <PageHeader title="Database" description="Tables, rows, এবং SQL runner।" />

      <div className="grid lg:grid-cols-[220px_1fr] gap-6">
        <aside className="rounded-lg border border-border bg-card p-3 h-fit">
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">public</div>
          <ul className="mt-1 space-y-0.5">
            {tables.map((t) => (
              <li key={t.name}>
                <button
                  onClick={() => setActive(t.name)}
                  className={
                    "w-full text-left px-2 py-1.5 rounded text-sm transition-colors " +
                    (active === t.name ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")
                  }
                >
                  {t.name}
                  <span className="ml-2 text-[11px] text-muted-foreground">{t.row_count}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="border-b border-border px-4 py-3 flex items-center justify-between">
            <div>
              <div className="font-medium text-sm">{active ?? "—"}</div>
              <div className="text-xs text-muted-foreground">{activeTable?.row_count ?? 0} rows · {activeTable?.columns.length ?? 0} columns</div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  {activeTable?.columns.map((c) => (
                    <th key={c.name} className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">
                      {c.name} <span className="text-[10px] opacity-70">{c.type}</span>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    {activeTable?.columns.map((c) => (
                      <td key={c.name} className="px-3 py-2 font-mono text-xs">{String(r[c.name] ?? "")}</td>
                    ))}
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => onDelete(String(r.id))} className="text-muted-foreground hover:text-destructive">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={(activeTable?.columns.length ?? 0) + 1} className="px-3 py-8 text-center text-sm text-muted-foreground">No rows.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="mt-8 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">SQL runner</h2>
          <button onClick={runSql} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90">
            <Play className="h-3.5 w-3.5" /> Run
          </button>
        </div>
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          className="mt-3 w-full h-28 rounded-md border border-input bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring"
        />
        {sqlResult && (
          <div className="mt-3 overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>{sqlResult.columns.map((c) => <th key={c} className="text-left px-3 py-2 font-medium">{c}</th>)}</tr>
              </thead>
              <tbody>
                {sqlResult.rows.map((row, i) => (
                  <tr key={i} className="border-t border-border">{row.map((v, j) => <td key={j} className="px-3 py-2 font-mono">{String(v)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
