// Enriched migration error renderer — parses the enriched string produced by
// vps-deployer.applyMigration and displays SQLSTATE, HINT, DETAIL, and the
// offending schema.table.column plus a NEAR-position SQL snippet.
//
// The upstream apply endpoint returns { error, message, pg, snippet }. The
// deployer flattens that into a single string of the form:
//   "<message> — [SQLSTATE 42703 · WHERE ... · HINT ... · DETAIL ... · AT admin.workspaces.owner_id] — NEAR: …<sql>…"
// so this component can regex it back into fields without a type change.
import { AlertOctagon, MapPin, Info, Code2 } from "lucide-react";

export type ParsedMigrationError = {
  message: string;
  sqlstate: string | null;
  where: string | null;
  hint: string | null;
  detail: string | null;
  at: string | null;
  snippet: string | null;
};

export function parseMigrationError(raw: string): ParsedMigrationError | null {
  if (!raw) return null;
  // Must look like an apply-failure enriched line — either an "apply HTTP"
  // prefix from vps-deployer or a raw JSON envelope from /admin/v1/migrations/*/apply.
  const looksLikeMigration = /apply HTTP|apply_failed|SQLSTATE|invalid input syntax|does not exist/i.test(raw);
  if (!looksLikeMigration) return null;

  // Try JSON envelope first (raw response body).
  try {
    // The deployer often prefixes with "apply HTTP 400: ", strip it.
    const jsonStart = raw.indexOf("{");
    if (jsonStart >= 0) {
      const j = JSON.parse(raw.slice(jsonStart)) as {
        message?: string; snippet?: string | null;
        pg?: {
          code?: string | null; where?: string | null; hint?: string | null; detail?: string | null;
          schema?: string | null; table?: string | null; column?: string | null;
        } | null;
      };
      if (j && (j.message || j.pg)) {
        const at = [j.pg?.schema, j.pg?.table, j.pg?.column].filter(Boolean).join(".") || null;
        return {
          message: j.message || raw.slice(0, 300),
          sqlstate: j.pg?.code ?? null,
          where: j.pg?.where ?? null,
          hint: j.pg?.hint ?? null,
          detail: j.pg?.detail ?? null,
          at,
          snippet: j.snippet ?? null,
        };
      }
    }
  } catch { /* fall through */ }

  // Parse the flattened bracket form used by the deployer.
  const message = raw.replace(/^\S+ HTTP \d+:\s*/, "").split(" — [")[0].trim();
  const bracket = raw.match(/\[([^\]]+)\]/);
  const bits = bracket ? bracket[1].split(" · ") : [];
  const grab = (prefix: string) => {
    const b = bits.find((x) => x.startsWith(prefix + " "));
    return b ? b.slice(prefix.length + 1) : null;
  };
  const near = raw.match(/NEAR:\s*…?([^…]+)…?/);
  return {
    message,
    sqlstate: grab("SQLSTATE"),
    where: grab("WHERE"),
    hint: grab("HINT"),
    detail: grab("DETAIL"),
    at: grab("AT"),
    snippet: near ? near[1].trim() : null,
  };
}

export function MigrationErrorCard({ raw }: { raw: string }) {
  const p = parseMigrationError(raw);
  if (!p) return null;
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 space-y-2 text-xs">
      <div className="flex items-start gap-2">
        <AlertOctagon className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-destructive">Migration apply failed</div>
          <div className="mt-0.5 text-foreground/90 break-words">{p.message}</div>
        </div>
        {p.sqlstate && (
          <span className="shrink-0 rounded-full border border-destructive/40 bg-background px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-destructive">
            SQLSTATE {p.sqlstate}
          </span>
        )}
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {p.at && (
          <div className="flex items-start gap-1.5">
            <MapPin className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground" />
            <span className="text-muted-foreground">Offending:</span>
            <code className="font-mono text-foreground/90 truncate" title={p.at}>{p.at}</code>
          </div>
        )}
        {p.hint && (
          <div className="flex items-start gap-1.5">
            <Info className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground" />
            <span className="text-muted-foreground">Hint:</span>
            <span className="text-foreground/90">{p.hint}</span>
          </div>
        )}
        {p.detail && (
          <div className="flex items-start gap-1.5 sm:col-span-2">
            <Info className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground" />
            <span className="text-muted-foreground">Detail:</span>
            <span className="text-foreground/90">{p.detail}</span>
          </div>
        )}
        {p.where && (
          <div className="flex items-start gap-1.5 sm:col-span-2">
            <Info className="h-3 w-3 shrink-0 mt-0.5 text-muted-foreground" />
            <span className="text-muted-foreground">Where:</span>
            <span className="text-foreground/90 truncate" title={p.where}>{p.where}</span>
          </div>
        )}
      </div>

      {p.snippet && (
        <div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Code2 className="h-3 w-3" />
            NEAR (±160 chars around the failing statement):
          </div>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] whitespace-pre-wrap">
            {p.snippet}
          </pre>
        </div>
      )}
    </div>
  );
}
