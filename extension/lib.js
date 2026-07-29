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
