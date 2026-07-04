// Client-side CSV export. Serialises the sorted, currently-visible rows —
// server-side full-table export lives on the roadmap (out of scope).

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // RFC 4180 — quote when comma, quote, CR, or LF present; escape quotes as "".
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns?: (keyof T)[],
): string {
  if (!rows.length) return columns?.length ? columns.map(String).join(",") + "\n" : "";
  const cols = (columns ?? (Object.keys(rows[0]) as (keyof T)[])).map(String);
  const header = cols.map(escapeCell).join(",");
  const body = rows.map(r => cols.map(c => escapeCell((r as Record<string, unknown>)[c])).join(",")).join("\n");
  return header + "\n" + body + "\n";
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
