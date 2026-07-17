// Client-side Laravel + React/Vite project analyzer.
// Uses JSZip to walk the uploaded archive without ever executing user code.
import JSZip from "jszip";
import type { AnalyzeResult, Column, FileNode, LaravelRoute, TableDef } from "./types";

const SKIP_DIRS = [
  "node_modules/", "vendor/", ".git/", "dist/", "build/",
  "storage/logs/", "storage/framework/cache/", ".next/", ".cache/",
];

function shouldSkip(path: string): boolean {
  return SKIP_DIRS.some((d) => path.includes(d));
}

// ── Laravel migration PHP parser (regex-based, static-only) ──────────────
function parseMigration(php: string): TableDef[] {
  const tables: TableDef[] = [];
  const createRe = /Schema::create\s*\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(php)) !== null) {
    const name = m[1];
    const body = m[2];
    const cols: Column[] = [];
    let timestamps = false;
    let softDeletes = false;

    // $table->id();
    if (/\$table->id\s*\(/.test(body)) {
      cols.push({ name: "id", type: "uuid", primary: true, default: "gen_random_uuid()" });
    }
    if (/\$table->timestamps\s*\(/.test(body)) timestamps = true;
    if (/\$table->softDeletes\s*\(/.test(body)) softDeletes = true;

    // Generic columns: $table->TYPE('name'[, ...])
    const colRe = /\$table->(\w+)\s*\(\s*['"]([^'"]+)['"](.*?)\)(->[^;]*)?;/g;
    let cm: RegExpExecArray | null;
    while ((cm = colRe.exec(body)) !== null) {
      const t = cm[1];
      const cname = cm[2];
      const chain = cm[4] ?? "";
      if (["id", "timestamps", "softDeletes"].includes(t)) continue;
      const pgType = mapLaravelType(t, cm[3]);
      if (!pgType) continue;
      const col: Column = {
        name: cname,
        type: pgType,
        nullable: /->nullable\s*\(/.test(chain),
        unique: /->unique\s*\(/.test(chain),
      };
      const defMatch = chain.match(/->default\s*\(\s*(['"]?)([^'")]+)\1\s*\)/);
      if (defMatch) col.default = defMatch[2];
      if (t === "foreignId" || cname.endsWith("_id")) {
        const table = cname.replace(/_id$/, "") + "s";
        col.references = { table, column: "id" };
        col.type = "uuid";
      }
      cols.push(col);
    }

    tables.push({ name, columns: cols, timestamps, softDeletes });
  }
  return tables;
}

function mapLaravelType(t: string, _args: string): string | null {
  const map: Record<string, string> = {
    string: "text", text: "text", longText: "text", mediumText: "text",
    integer: "integer", bigInteger: "bigint", smallInteger: "smallint",
    tinyInteger: "smallint", unsignedBigInteger: "bigint", unsignedInteger: "integer",
    boolean: "boolean", date: "date", dateTime: "timestamptz",
    timestamp: "timestamptz", time: "time", json: "jsonb", jsonb: "jsonb",
    decimal: "numeric", float: "double precision", double: "double precision",
    uuid: "uuid", ipAddress: "inet", macAddress: "macaddr",
    binary: "bytea", enum: "text", foreignId: "uuid",
  };
  return map[t] ?? null;
}

// ── Laravel routes/api.php parser ────────────────────────────────────────
function parseRoutes(php: string): LaravelRoute[] {
  const out: LaravelRoute[] = [];
  const re = /Route::(get|post|put|patch|delete|any|match)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\[?[^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(php)) !== null) {
    out.push({
      method: m[1].toUpperCase(),
      uri: m[2].startsWith("/") ? m[2] : "/" + m[2],
      controller: m[3].replace(/\s+/g, " ").slice(0, 200),
    });
  }
  // Route::apiResource('posts', PostController::class)
  const resRe = /Route::apiResource\s*\(\s*['"]([^'"]+)['"]\s*,\s*([\w\\]+)/g;
  while ((m = resRe.exec(php)) !== null) {
    const base = m[1];
    const ctl = m[2];
    for (const [method, path] of [
      ["GET", `/${base}`], ["POST", `/${base}`],
      ["GET", `/${base}/{id}`], ["PUT", `/${base}/{id}`],
      ["PATCH", `/${base}/{id}`], ["DELETE", `/${base}/{id}`],
    ] as const) {
      out.push({ method, uri: path, controller: ctl });
    }
  }
  return out;
}

// ── Laravel model parser ─────────────────────────────────────────────────
function parseModel(php: string, file: string) {
  const nameM = php.match(/class\s+(\w+)\s+extends\s+Model/);
  if (!nameM) return null;
  const tableM = php.match(/protected\s+\$table\s*=\s*['"]([^'"]+)['"]/);
  const fillM = php.match(/protected\s+\$fillable\s*=\s*\[([^\]]*)\]/);
  const fillable = fillM
    ? Array.from(fillM[1].matchAll(/['"]([^'"]+)['"]/g)).map((x) => x[1])
    : undefined;
  return { name: nameM[1], file, table: tableM?.[1], fillable };
}

// ── Frontend API call site scanner ───────────────────────────────────────
// Matches axios / fetch AND common Supabase JS client patterns
// (supabase.from, .rpc, .auth.*, .storage.from, .functions.invoke).
function scanApiCalls(file: string, src: string) {
  const hits: { file: string; snippet: string; line: number }[] = [];
  const patterns: RegExp[] = [
    /(axios\.(?:get|post|put|patch|delete)|fetch)\s*\(\s*(['"`])([^'"`]+)\2/g,
    /\bsupabase\s*\.\s*(?:from|rpc|storage\.from|functions\.invoke)\s*\(\s*(['"`])([^'"`]+)\1/g,
    /\bsupabase\s*\.\s*auth\s*\.\s*(\w+)\s*\(/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(0, m.index);
      const line = before.split("\n").length;
      hits.push({ file, snippet: m[0].slice(0, 160), line });
    }
  }
  return hits;
}

// ── Supabase SQL migration parser (regex-only, static) ───────────────────
function parseSupabaseMigration(sql: string): { tables: TableDef[]; extraPreamble: string[] } {
  const tables: TableDef[] = [];
  const extraPreamble: string[] = [];

  // Extract CREATE TYPE ... AS ENUM(...) so downstream CREATE TABLE columns
  // that reference the custom type (e.g. `status ticket_status NOT NULL`)
  // don't fail with `type "ticket_status" does not exist` when the emitted
  // migration is applied to a fresh Postgres.
  const enumRe = /create\s+type\s+(?:if\s+not\s+exists\s+)?(?:(?:"?public"?)\s*\.\s*)?"?(\w+)"?\s+as\s+enum\s*\(([^)]*)\)\s*;/gi;
  let em: RegExpExecArray | null;
  while ((em = enumRe.exec(sql)) !== null) {
    const typeName = em[1];
    const values = em[2];
    const safeTypeName = typeName.replace(/"/g, "");
    const qTypeName = /^[a-z_][a-z0-9_]*$/i.test(safeTypeName) ? safeTypeName : `"${safeTypeName.replace(/"/g, '""')}"`;
    extraPreamble.push(
      `DO $$ BEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = '${safeTypeName.replace(/'/g, "''")}') THEN\n    CREATE TYPE public.${qTypeName} AS ENUM (${values.trim()});\n  END IF;\nEND $$;`
    );
  }

  const createRe =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql)) !== null) {
    const name = m[1];
    const body = m[2];
    const cols: Column[] = [];
    const lines = body.split(/,\s*\n/).map((l) => l.trim()).filter(Boolean);
    for (const raw of lines) {
      const line = raw.replace(/,+$/, "").trim();
      if (!line) continue;
      if (/^(primary\s+key|foreign\s+key|unique|check|constraint)\b/i.test(line)) continue;
      const colM = line.match(/^"?(\w+)"?\s+([a-zA-Z][\w \[\]()]*?)(\s|$)/);
      if (!colM) continue;
      const col: Column = {
        name: colM[1],
        type: colM[2].trim().toLowerCase(),
        nullable: !/not\s+null/i.test(line),
        primary: /\bprimary\s+key\b/i.test(line),
        unique: /\bunique\b/i.test(line) && !/references/i.test(line),
      };
      const def = line.match(/default\s+([^\s,]+(?:\([^)]*\))?)/i);
      if (def) col.default = def[1];
      const ref = line.match(/references\s+(?:public\.)?"?(\w+)"?\s*\(\s*"?(\w+)"?\s*\)/i);
      if (ref) col.references = { table: ref[1], column: ref[2] };
      cols.push(col);
    }
    if (cols.length) tables.push({ name, columns: cols });
  }
  return { tables, extraPreamble };
}

// ── Main entry ───────────────────────────────────────────────────────────
export async function analyzeZip(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<AnalyzeResult> {
  const zip = await JSZip.loadAsync(file);
  const result: AnalyzeResult = {
    frontend: { detected: false, hasVite: false, apiCallSites: [], envKeys: [], baseUrls: [] },
    backend: {
      detected: false, tables: [], models: [], routes: [], controllers: [],
      storageDisks: [], envKeys: [], envExample: {}, rawMigrationFiles: 0,
    },
    files: [],
    stats: { totalFiles: 0, totalBytes: 0, usedFiles: 0, skipped: [] },
  };
  const pushFile = (n: FileNode) => { result.files.push(n); if (n.used) result.stats.usedFiles++; };
  const kindOf = (p: string): FileNode["kind"] => {
    if (/\.(php|blade\.php)$/i.test(p) || p.includes("/app/") || p.includes("/routes/") || p.includes("/database/")) return "backend";
    if (/\.(tsx?|jsx?|css|html)$/i.test(p) || p.includes("/src/") || p.includes("/resources/js/")) return "frontend";
    if (/\.(json|env|yml|yaml|toml|md)$/i.test(p) || p.includes("/config/")) return "config";
    return "other";
  };

  const entries = Object.values(zip.files).filter((e) => !e.dir);
  for (const entry of entries) {
    if (shouldSkip(entry.name)) {
      result.stats.skipped.push(entry.name);
      continue;
    }
    result.stats.totalFiles += 1;
    const lower = entry.name.toLowerCase();

    // Read only reasonable text files
    const isText = /\.(php|ts|tsx|js|jsx|json|env|md|yml|yaml|sql|blade\.php)$/.test(lower);
    let used = false;
    let usedReason: string | undefined;
    const markUsed = (r: string) => { used = true; usedReason = usedReason ?? r; };
    if (!isText) {
      pushFile({ path: entry.name, size: 0, kind: kindOf(entry.name), used: false });
      continue;
    }

    const text = await entry.async("string");
    result.stats.totalBytes += text.length;

    // ── Backend signals ──
    if (lower.endsWith("composer.json")) {
      result.backend.detected = true;
      try {
        const j = JSON.parse(text);
        const laravel = j.require?.["laravel/framework"] ?? j.require?.["laravel/lumen-framework"];
        if (laravel) result.backend.laravelVersion = String(laravel);
      } catch { /* ignore */ }
      onProgress?.(`Laravel detected (${entry.name})`);
    }
    if (/database\/migrations\/.+\.php$/.test(lower)) {
      result.backend.rawMigrationFiles += 1;
      result.backend.tables.push(...parseMigration(text));
    }
    // Supabase / Lovable Cloud migrations (`supabase/migrations/*.sql`)
    if (/(^|\/)supabase\/migrations\/.+\.sql$/.test(lower)) {
      result.backend.detected = true;
      result.backend.rawMigrationFiles += 1;
      const parsed = parseSupabaseMigration(text);
      result.backend.tables.push(...parsed.tables);
      if (parsed.extraPreamble.length) {
        result.backend.extraPreambleSql = [
          ...(result.backend.extraPreambleSql ?? []),
          ...parsed.extraPreamble,
        ];
      }
      markUsed("supabase migration");
    }
    if (/app\/models\/.+\.php$/.test(lower)) {
      const mm = parseModel(text, entry.name);
      if (mm) result.backend.models.push(mm);
    }
    if (/routes\/(api|web)\.php$/.test(lower)) {
      result.backend.routes.push(...parseRoutes(text));
    }
    if (/app\/http\/controllers\/.+\.php$/.test(lower)) {
      const nameM = text.match(/class\s+(\w+)/);
      const methods = Array.from(text.matchAll(/public\s+function\s+(\w+)/g)).map((x) => x[1]);
      if (nameM) result.backend.controllers.push({ name: nameM[1], file: entry.name, methods });
    }
    if (lower.endsWith("config/auth.php")) {
      const m = text.match(/'default'\s*=>\s*\[[^\]]*'guard'\s*=>\s*['"]([^'"]+)/);
      if (m) result.backend.authGuard = m[1];
    }
    if (lower.endsWith("config/filesystems.php")) {
      const disks = Array.from(text.matchAll(/'(local|public|s3|ftp|sftp)'\s*=>\s*\[/g)).map((x) => x[1]);
      result.backend.storageDisks.push(...new Set(disks));
    }

    // ── Frontend signals ──
    if (lower.endsWith("package.json") && !entry.name.includes("/vendor/")) {
      try {
        const j = JSON.parse(text);
        const deps = { ...j.dependencies, ...j.devDependencies };
        if (deps.react) {
          result.frontend.detected = true;
          result.frontend.framework = "react";
        }
        if (deps.vite) result.frontend.hasVite = true;
      } catch { /* ignore */ }
    }
    if (/vite\.config\.(t|j)s$/.test(lower)) {
      result.frontend.hasVite = true;
      result.frontend.detected = true;
    }
    if (/\.(tsx?|jsx?)$/.test(lower) && !entry.name.includes("/vendor/")) {
      const hits = scanApiCalls(entry.name, text);
      if (hits.length) result.frontend.apiCallSites.push(...hits);
      const base = text.match(/baseURL\s*[:=]\s*['"`]([^'"`]+)/);
      if (base) result.frontend.baseUrls.push(base[1]);
    }

    // ── .env keys ──
    if (lower.endsWith(".env") || lower.endsWith(".env.example")) {
      const kv = Array.from(text.matchAll(/^([A-Z0-9_]+)=(.*)$/gm));
      const pathHint = entry.name.toLowerCase();
      const backendHinted =
        pathHint.includes("backend") ||
        pathHint.includes("server") ||
        pathHint.includes("laravel") ||
        pathHint.includes("api/");
      for (const m of kv) {
        const key = m[1];
        const isFrontendKey = /^(VITE_|NEXT_PUBLIC_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_)/.test(key);
        // Per-key routing: VITE_/NEXT_PUBLIC_/… always frontend, even from
        // a root .env; otherwise fall back to the file-path hint.
        if (isFrontendKey && !backendHinted) {
          result.frontend.envKeys.push(key);
        } else if (
          pathHint.includes("frontend") ||
          pathHint.startsWith("client") ||
          (isFrontendKey && !backendHinted)
        ) {
          result.frontend.envKeys.push(key);
        } else {
          result.backend.envKeys.push(key);
          result.backend.envExample[key] = m[2].trim();
        }
      }
      markUsed("env keys");
    }

    // Detect used markers for various backend/frontend patterns
    if (/database\/migrations\/.+\.php$/.test(lower)) markUsed("migration");
    else if (/app\/models\/.+\.php$/.test(lower)) markUsed("model");
    else if (/routes\/(api|web)\.php$/.test(lower)) markUsed("route");
    else if (/app\/http\/controllers\/.+\.php$/.test(lower)) markUsed("controller");
    else if (lower.endsWith("composer.json") || lower.endsWith("package.json")) markUsed("manifest");
    else if (/vite\.config\.(t|j)s$/.test(lower)) markUsed("vite config");
    else if (/\.(tsx?|jsx?)$/.test(lower) && !entry.name.includes("/vendor/")) {
      if (scanApiCalls(entry.name, text).length) markUsed("api call site");
    } else if (/config\/(auth|filesystems)\.php$/.test(lower)) markUsed("laravel config");

    pushFile({ path: entry.name, size: text.length, kind: kindOf(entry.name), used, reason: usedReason });
  }

  onProgress?.(`Scanned ${result.stats.totalFiles} files (${result.stats.usedFiles} used)`);
  return result;
}
