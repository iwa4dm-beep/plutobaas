import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";
export interface UsePaginatedTableResult<T> {
  page: number;
  pageSize: number;
  totalPages: number;
  sortKey: keyof T | null;
  sortDir: SortDir;
  rows: T[];             // sorted + paginated slice
  sorted: T[];           // full sorted list (for CSV export)
  setPage: (n: number) => void;
  setPageSize: (n: number) => void;
  toggleSort: (key: keyof T) => void;
}

// Small client-side sort + paginate helper. Backends already return
// bounded lists (~500 rows for these dashboards), so avoiding the
// server round-trip is fine for the first pass.
export function usePaginatedTable<T extends Record<string, unknown>>(
  data: T[],
  opts: { pageSize?: number; defaultSort?: { key: keyof T; dir?: SortDir } } = {},
): UsePaginatedTableResult<T> {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(opts.pageSize ?? 25);
  const [sortKey, setSortKey] = useState<keyof T | null>(opts.defaultSort?.key ?? null);
  const [sortDir, setSortDir] = useState<SortDir>(opts.defaultSort?.dir ?? "desc");

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    const k = sortKey;
    const dir = sortDir === "asc" ? 1 : -1;
    const clone = [...data];
    clone.sort((a, b) => {
      const av = a[k]; const bv = b[k];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return clone;
  }, [data, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = useMemo(() => sorted.slice((safePage - 1) * pageSize, safePage * pageSize),
                       [sorted, safePage, pageSize]);

  const toggleSort = (key: keyof T) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
    setPage(1);
  };

  return { page: safePage, pageSize, totalPages, sortKey, sortDir, rows, sorted, setPage, setPageSize, toggleSort };
}
