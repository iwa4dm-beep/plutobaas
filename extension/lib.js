// Shared helpers for the Pluto Migrator (popup + service worker).

/** HMAC-SHA256 hex over `${ts}.${body}`. Secret never leaves the browser. */
export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* Profiles: several endpoint/secret pairs (prod, staging, local…)      */
/* ------------------------------------------------------------------ */

export const DEFAULT_ENDPOINT = "https://plutobaas.lovable.app/api/public/pluto-import";

export async function getProfiles() {
  const { profiles, activeProfile } = await chrome.storage.local.get(["profiles", "activeProfile"]);
  const list = Array.isArray(profiles) && profiles.length
    ? profiles
    : [{ name: "default", endpoint: DEFAULT_ENDPOINT, secret: "" }];
  const active = list.find((p) => p.name === activeProfile) || list[0];
  return { list, active };
}

export async function saveProfile(profile) {
  const { list } = await getProfiles();
  const next = list.filter((p) => p.name !== profile.name).concat(profile);
  await chrome.storage.local.set({ profiles: next, activeProfile: profile.name });
  return next;
}

export async function setActiveProfile(name) {
  await chrome.storage.local.set({ activeProfile: name });
}

export async function deleteProfile(name) {
  const { list } = await getProfiles();
  const next = list.filter((p) => p.name !== name);
  await chrome.storage.local.set({ profiles: next.length ? next : undefined });
  return next;
}

/* ------------------------------------------------------------------ */
/* Secret scanner — refuses to ship credentials inside a payload        */
/* ------------------------------------------------------------------ */

const SECRET_RULES = [
  { id: "supabase_service_role", label: "Supabase service_role JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g },
  { id: "supabase_secret_key", label: "Supabase sb_secret key", re: /sb_secret_[A-Za-z0-9_-]{10,}/g },
  { id: "github_token", label: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { id: "openai_key", label: "OpenAI/LLM API key", re: /sk-[A-Za-z0-9]{20,}/g },
  { id: "aws_key", label: "AWS access key id", re: /AKIA[0-9A-Z]{16}/g },
  { id: "pg_url", label: "Postgres connection string with password", re: /postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@[^\s/]+/g },
  { id: "private_key", label: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/** Returns { findings, redacted } — findings list what matched and where. */
export function scanSecrets(payload) {
  const findings = [];
  const walk = (value, path) => {
    if (typeof value === "string") {
      let out = value;
      for (const rule of SECRET_RULES) {
        const hits = value.match(rule.re);
        if (hits?.length) {
          findings.push({ rule: rule.id, label: rule.label, path, count: hits.length });
          out = out.replace(rule.re, `[REDACTED:${rule.id}]`);
        }
      }
      return out;
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`));
    if (value && typeof value === "object") {
      const o = {};
      for (const [k, v] of Object.entries(value)) o[k] = walk(v, path ? `${path}.${k}` : k);
      return o;
    }
    return value;
  };
  const redacted = walk(payload, "");
  return { findings, redacted };
}

/* ------------------------------------------------------------------ */
/* Merge multiple tab descriptors into one migration payload            */
/* ------------------------------------------------------------------ */

export function mergeDescriptors(descriptors) {
  const merged = { sources: [] };
  for (const d of descriptors) {
    if (!d) continue;
    merged.sources.push(d.source);
    if (d.lovable) merged.lovable = { ...(merged.lovable || {}), ...d.lovable };
    if (d.supabase) {
      const prev = merged.supabase || {};
      merged.supabase = {
        ...prev,
        ...d.supabase,
        // keep the biggest dump we found across tabs
        schema_sql:
          (d.supabase.schema_sql?.length || 0) > (prev.schema_sql?.length || 0)
            ? d.supabase.schema_sql
            : prev.schema_sql,
        tables: [...new Set([...(prev.tables || []), ...(d.supabase.tables || [])])],
      };
      if (!merged.supabase.tables.length) delete merged.supabase.tables;
    }
    if (d.repo && !merged.repo) {
      merged.repo = d.repo;
      merged.ref = d.ref || merged.ref;
      merged.zipball_url = d.zipball_url || merged.zipball_url;
      merged.repo_private = d.private ?? merged.repo_private;
    }
  }
  merged.sources = [...new Set(merged.sources)];
  merged.collected_at = new Date().toISOString();
  return merged;
}

/** Human readable readiness report shown before sending. */
export function preflight(payload) {
  const checks = [];
  const add = (ok, level, label) => checks.push({ ok, level, label });
  add(!!payload.repo, "warn", payload.repo ? `Repo: ${payload.repo}` : "No GitHub repo detected");
  add(!!payload.zipball_url, "warn", payload.zipball_url ? "Zipball URL ready" : "No zipball URL (open the repo tab)");
  const sql = payload.supabase?.schema_sql;
  add(!!sql, "error", sql ? `Schema SQL: ${sql.length.toLocaleString()} chars` : "No Supabase schema SQL captured");
  add(!!payload.supabase?.ref, "warn", payload.supabase?.ref ? `Supabase ref: ${payload.supabase.ref}` : "No Supabase project ref");
  add(!!payload.lovable?.project_id, "info", payload.lovable?.project_id ? "Lovable project linked" : "No Lovable project tab");
  const tables = payload.supabase?.tables?.length || 0;
  add(tables > 0, "info", tables ? `${tables} table names collected` : "No table inventory");
  return checks;
}

/* ------------------------------------------------------------------ */
/* Job history                                                         */
/* ------------------------------------------------------------------ */

export async function getHistory() {
  const { history } = await chrome.storage.local.get("history");
  return Array.isArray(history) ? history : [];
}

export async function pushHistory(entry) {
  const history = await getHistory();
  const next = [entry, ...history.filter((h) => h.event_id !== entry.event_id)].slice(0, 50);
  await chrome.storage.local.set({ history: next });
  return next;
}

export async function updateHistory(eventId, patch) {
  const history = await getHistory();
  const next = history.map((h) => (h.event_id === eventId ? { ...h, ...patch } : h));
  await chrome.storage.local.set({ history: next });
  return next;
}

/* ------------------------------------------------------------------ */
/* v3 — status channel, chunking, SQL lens, watchers, auto-capture      */
/* ------------------------------------------------------------------ */

/** The signed control endpoint lives next to the ingest endpoint. */
export function statusEndpoint(ingest) {
  return String(ingest || DEFAULT_ENDPOINT).replace(/pluto-import(?:$|\?)/, "pluto-import-status");
}

export const CHUNK_TARGET = 512 * 1024; // 512 KB per request

/** Size-aware split: small payloads stay single-shot, big dumps get chunked. */
export function planChunks(sql, target = CHUNK_TARGET) {
  const text = String(sql || "");
  if (text.length <= target) return [];
  const chunks = [];
  for (let i = 0; i < text.length; i += target) chunks.push(text.slice(i, i + target));
  return chunks;
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---- SQL Lens: quick statistics + lint before anything is shipped ---- */

export function sqlLens(sql) {
  const text = String(sql || "");
  const count = (re) => (text.match(re) || []).length;
  const stats = {
    chars: text.length,
    statements: count(/;\s*(?:\n|$)/g),
    create_table: count(/\bcreate\s+table\b/gi),
    create_view: count(/\bcreate\s+(?:or\s+replace\s+)?view\b/gi),
    create_function: count(/\bcreate\s+(?:or\s+replace\s+)?function\b/gi),
    policies: count(/\bcreate\s+policy\b/gi),
    triggers: count(/\bcreate\s+trigger\b/gi),
    inserts: count(/\binsert\s+into\b/gi),
    drops: count(/\bdrop\s+/gi),
    truncates: count(/\btruncate\b/gi),
  };
  const lint = [];
  if (!stats.chars) lint.push({ level: "error", text: "No SQL captured." });
  if (stats.drops) lint.push({ level: "warn", text: `${stats.drops} DROP statement(s) — destructive on apply.` });
  if (stats.truncates) lint.push({ level: "error", text: `${stats.truncates} TRUNCATE statement(s) — data loss risk.` });
  if (stats.create_table && !stats.policies) lint.push({ level: "warn", text: "Tables without any RLS policy — add policies after import." });
  if (/\bauth\.uid\(\)/i.test(text) && !/create schema if not exists auth/i.test(text)) {
    lint.push({ level: "info", text: "Uses auth.uid() — Pluto provides a compatible shim." });
  }
  if (/\bextension\s+"?(?:pg_net|pgsodium|supabase_vault)"?/i.test(text)) {
    lint.push({ level: "warn", text: "Supabase-only extensions referenced; they will be skipped." });
  }
  if (stats.chars > CHUNK_TARGET) lint.push({ level: "info", text: "Large dump — resumable chunked upload will be used." });
  return { stats, lint };
}

/* ---- delta detection against the previously sent dump ---------------- */

export async function computeDelta(payload) {
  const sql = payload?.supabase?.schema_sql || "";
  const key = payload?.repo || payload?.supabase?.ref || "default";
  const hash = sql ? await sha256Hex(sql) : null;
  const { deltas } = await chrome.storage.local.get("deltas");
  const map = deltas || {};
  const prev = map[key];
  const result = prev
    ? {
        key,
        changed: prev.hash !== hash,
        prev_chars: prev.chars,
        chars: sql.length,
        delta: sql.length - prev.chars,
        prev_at: prev.at,
      }
    : { key, changed: true, prev_chars: null, chars: sql.length, delta: null, prev_at: null };
  return { result, commit: async () => {
    map[key] = { hash, chars: sql.length, at: new Date().toISOString() };
    await chrome.storage.local.set({ deltas: map });
  } };
}

/* ---- watchers: jobs whose status we keep polling in the background --- */

export async function getWatchers() {
  const { watchers } = await chrome.storage.local.get("watchers");
  return Array.isArray(watchers) ? watchers : [];
}
export async function addWatcher(jobId, meta = {}) {
  const list = await getWatchers();
  const next = [{ job_id: jobId, since: null, last_status: null, ...meta }, ...list.filter((w) => w.job_id !== jobId)].slice(0, 20);
  await chrome.storage.local.set({ watchers: next });
  return next;
}
export async function setWatchers(list) {
  await chrome.storage.local.set({ watchers: list.slice(0, 20) });
}
export async function removeWatcher(jobId) {
  await setWatchers((await getWatchers()).filter((w) => w.job_id !== jobId));
}

/* ---- generic settings ------------------------------------------------ */

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { autoCaptureMinutes: 0, chunkKb: 512, watchIntervalMin: 1, ...(settings || {}) };
}
export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
