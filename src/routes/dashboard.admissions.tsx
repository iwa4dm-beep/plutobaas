import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { GraduationCap, RefreshCw, Search, ShieldAlert, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { pluto } from "@/lib/pluto/client";

export const Route = createFileRoute("/dashboard/admissions")({
  component: AdmissionsPage,
});

type Admission = {
  id: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  student_name: string;
  date_of_birth: string;
  gender: "male" | "female" | "other";
  blood_group: string | null;
  religion: string | null;
  nationality: string | null;
  previous_school: string | null;
  class_applying_for: string;
  father_name: string;
  mother_name: string;
  guardian_name: string | null;
  mobile: string;
  alternate_mobile: string | null;
  email: string | null;
  address: string;
  city: string | null;
  postal_code: string | null;
  notes: string | null;
};

const COLS = [
  "id","created_at","updated_at","created_by","student_name","date_of_birth","gender",
  "blood_group","religion","nationality","previous_school","class_applying_for",
  "father_name","mother_name","guardian_name","mobile","alternate_mobile","email",
  "address","city","postal_code","notes",
] as const;

function rowsToObjects(res: { columns: string[]; rows: unknown[][] }): Admission[] {
  return res.rows.map((r) => {
    const o: Record<string, unknown> = {};
    res.columns.forEach((c, i) => { o[c] = r[i]; });
    return o as unknown as Admission;
  });
}

function AdmissionsPage() {
  const [rows, setRows] = useState<Admission[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Admission | null>(null);
  const [tableMissing, setTableMissing] = useState(false);

  async function refresh() {
    setLoading(true); setErr(null); setTableMissing(false);
    try {
      const colList = COLS.map((c) => `"${c}"`).join(", ");
      const res = await pluto.db.runSql(
        `select ${colList} from public.admissions order by created_at desc limit 500`,
      );
      setRows(rowsToObjects(res));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/admissions.*does not exist|relation .*admissions.* does not exist/i.test(msg)) {
        setTableMissing(true);
      } else {
        setErr(msg);
      }
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) =>
      r.student_name?.toLowerCase().includes(s) ||
      r.mobile?.toLowerCase().includes(s) ||
      r.id?.toLowerCase().includes(s) ||
      r.father_name?.toLowerCase().includes(s) ||
      r.mother_name?.toLowerCase().includes(s) ||
      r.class_applying_for?.toLowerCase().includes(s),
    );
  }, [rows, q]);

  async function remove(id: string, name: string) {
    if (!confirm(`Delete admission ${id} (${name})? This cannot be undone.`)) return;
    setBusy(id); setErr(null);
    try {
      await pluto.db.runSql(`delete from public.admissions where id = '${id.replace(/'/g, "''")}'`);
      setSelected((s) => (s?.id === id ? null : s));
      await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  return (
    <div>
      <PageHeader
        title="Admissions"
        description="School admission portal থেকে আসা সব admission record — Pluto backend থেকে সরাসরি live data।"
      />

      {tableMissing && (
        <div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
          <div className="font-medium text-amber-700 dark:text-amber-400 mb-1">
            <GraduationCap className="inline h-4 w-4 mr-1" />
            <code>public.admissions</code> টেবিল এখনো তৈরি হয়নি
          </div>
          <div className="text-xs text-muted-foreground space-y-1">
            <div>Migration file আছে: <code>pluto-backend/migrations/0030_admissions.sql</code></div>
            <div>VPS এ চালান:</div>
            <pre className="mt-1 rounded bg-muted p-2 text-[11px] overflow-auto">cd /path/to/pluto-backend{"\n"}bash deploy/run-migrator.sh{"\n"}bash deploy/verify-migrations.sh</pre>
          </div>
        </div>
      )}

      {err && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Request failed</div>
            <div className="text-xs opacity-90 break-all">{err}</div>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, mobile, ID, class…"
            className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
          Refresh
        </button>
        <div className="text-xs text-muted-foreground ml-auto">
          {filtered.length} / {rows.length} rows
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Form #</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Student</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Class</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Mobile</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Father</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Submitted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-t border-border hover:bg-muted/30 cursor-pointer" onClick={() => setSelected(r)}>
                  <td className="px-4 py-2.5 font-mono text-xs">{r.id}</td>
                  <td className="px-4 py-2.5 font-medium">{r.student_name}</td>
                  <td className="px-4 py-2.5 text-xs">{r.class_applying_for}</td>
                  <td className="px-4 py-2.5 text-xs">{r.mobile}</td>
                  <td className="px-4 py-2.5 text-xs">{r.father_name}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); remove(r.id, r.student_name); }}
                      disabled={busy === r.id}
                      className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && !tableMissing && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-xs text-muted-foreground">
                  {rows.length === 0 ? "No admissions yet." : "No matches."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4" onClick={() => setSelected(null)}>
          <div className="w-full max-w-2xl rounded-lg border border-border bg-card shadow-elegant" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div>
                <div className="text-xs text-muted-foreground font-mono">Form #{selected.id}</div>
                <div className="text-lg font-semibold">{selected.student_name}</div>
              </div>
              <button onClick={() => setSelected(null)} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm max-h-[70vh] overflow-auto">
              <Field label="Date of Birth" value={selected.date_of_birth} />
              <Field label="Gender" value={selected.gender} />
              <Field label="Class Applying For" value={selected.class_applying_for} />
              <Field label="Blood Group" value={selected.blood_group} />
              <Field label="Religion" value={selected.religion} />
              <Field label="Nationality" value={selected.nationality} />
              <Field label="Previous School" value={selected.previous_school} />
              <Field label="Father" value={selected.father_name} />
              <Field label="Mother" value={selected.mother_name} />
              <Field label="Guardian" value={selected.guardian_name} />
              <Field label="Mobile" value={selected.mobile} />
              <Field label="Alternate Mobile" value={selected.alternate_mobile} />
              <Field label="Email" value={selected.email} />
              <Field label="City" value={selected.city} />
              <Field label="Postal Code" value={selected.postal_code} />
              <Field label="Submitted" value={selected.created_at ? new Date(selected.created_at).toLocaleString() : null} />
              <div className="col-span-2"><Field label="Address" value={selected.address} /></div>
              {selected.notes && <div className="col-span-2"><Field label="Notes" value={selected.notes} /></div>}
            </div>
            <div className="border-t border-border px-5 py-3 flex justify-end gap-2">
              <button
                onClick={() => remove(selected.id, selected.student_name)}
                disabled={busy === selected.id}
                className="inline-flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
              <button onClick={() => setSelected(null)} className="rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 break-words">{value ?? <span className="text-muted-foreground">—</span>}</div>
    </div>
  );
}
