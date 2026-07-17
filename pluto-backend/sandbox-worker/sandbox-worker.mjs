#!/usr/bin/env node
// Pluto Sandbox Worker — VPS-side ZIP unpacker + static site host.
//
// Responsibilities (v0.1):
//   1. Expose a tiny HTTP API on 127.0.0.1:${PORT} protected by a shared secret.
//   2. On POST /unpack { workspaceId, bucket, key } — download the ZIP from the
//      Pluto storage API, unpack it into /var/lib/pluto/sites/<workspaceId>/<ts>/,
//      atomically flip the "current" symlink, and return the served path.
//   3. GET /status/:workspaceId — report the currently-served bundle + timestamps.
//   4. GET /healthz — process liveness.
//   5. GET /sandbox/health (nginx strips to /health) — authenticated last-deploy status.
//
// Nginx (or Caddy) serves the "current" symlink for app.timescard.cloud, so
// after a successful /unpack the new frontend goes live with zero downtime.
//
// Environment:
//   PORT                       (default 8787)
//   SANDBOX_SHARED_SECRET      required — same value passed as x-sandbox-secret
//   SITES_ROOT                 default /var/lib/pluto/sites
//   PLUTO_UPSTREAM_URL         default http://127.0.0.1:8000   (Pluto API base)
//   PLUTO_SERVICE_ROLE_KEY     required — used to fetch bundle from storage
//
// Requires system `unzip` (apt install unzip). No npm dependencies.

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";

const PORT = Number(process.env.PORT ?? process.env.SANDBOX_WORKER_PORT ?? 8787);
const SECRET = process.env.SANDBOX_SHARED_SECRET ?? "";
const SITES_ROOT = process.env.SITES_ROOT ?? process.env.SANDBOX_SITES_ROOT ?? "/var/lib/pluto/sites";
const UPSTREAM = (process.env.PLUTO_UPSTREAM_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const SERVICE_KEY = process.env.PLUTO_SERVICE_ROLE_KEY ?? "";
const LAST_DEPLOY_FILE = path.join(SITES_ROOT, ".last-deploy.json");
const DEFAULT_BASE_DOMAIN = process.env.PLUTO_WILDCARD_HOST || process.env.BASE_DOMAIN || "app.timescard.cloud";
const NGINX_SITES_ENABLED = process.env.NGINX_SITES_ENABLED || "/etc/nginx/sites-enabled";
const NGINX_SITES_AVAILABLE = process.env.NGINX_SITES_AVAILABLE || "/etc/nginx/sites-available";

if (!SECRET) { console.error("SANDBOX_SHARED_SECRET is required"); process.exit(1); }
if (!SERVICE_KEY) console.warn("PLUTO_SERVICE_ROLE_KEY is not set; POST /unpack will fail until it is configured");

await fsp.mkdir(SITES_ROOT, { recursive: true });

function checkSecret(req) {
  const provided = req.headers["x-sandbox-secret"];
  if (typeof provided !== "string" || provided.length !== SECRET.length) return false;
  try { return timingSafeEqual(Buffer.from(provided), Buffer.from(SECRET)); } catch { return false; }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function requestPath(req) {
  try { return new URL(req.url || "/", "http://127.0.0.1").pathname; }
  catch { return req.url || "/"; }
}

function requestQuery(req) {
  try { return new URL(req.url || "/", "http://127.0.0.1").searchParams; }
  catch { return new URLSearchParams(); }
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf-8") || "{}";
  return JSON.parse(text);
}

function safeSlug(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

function safeDomain(s) {
  const out = String(s || "").trim().toLowerCase().replace(/^\*\./, "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return /^[a-z0-9.-]{3,253}$/.test(out) && !out.includes("..") ? out : DEFAULT_BASE_DOMAIN;
}

function normalizeSlug(s) {
  const out = String(s || "").trim().toLowerCase();
  return SLUG_RE.test(out) ? out : "";
}

function normalizeMigrations(input) {
  if (input == null) return null;
  if (typeof input === "number") return { ok: true, applied: input, count: input };
  if (typeof input !== "object") return { ok: null, detail: String(input).slice(0, 800) };
  const m = input;
  const out = {
    ok: typeof m.ok === "boolean" ? m.ok : null,
    applied: typeof m.applied === "number" ? m.applied : null,
    count: typeof m.count === "number" ? m.count : (typeof m.verifyCount === "number" ? m.verifyCount : null),
    migrationId: typeof m.migrationId === "string" ? m.migrationId : null,
    latest: m.latest && typeof m.latest === "object" ? m.latest : null,
    idempotent: typeof m.idempotent === "boolean" ? m.idempotent : null,
    verified: typeof m.verified === "boolean" ? m.verified : (typeof m.verifyOk === "boolean" ? m.verifyOk : null),
    detail: typeof m.detail === "string" ? m.detail.slice(0, 800) : null,
  };
  return out;
}

async function readManifestFile(wsDir, name) {
  try { return JSON.parse(await fsp.readFile(path.join(wsDir, name), "utf-8")); }
  catch { return null; }
}

function deployStamp(record) {
  const raw = record?.finishedAt ?? record?.servedAt ?? record?.publishedAt ?? record?.startedAt ?? record?.ts ?? null;
  const t = raw ? Date.parse(raw) : 0;
  return Number.isFinite(t) ? t : 0;
}

function recordMatches(record, filter) {
  if (!record) return false;
  if (filter?.workspaceId && String(record.workspaceId || "") !== filter.workspaceId) return false;
  if (filter?.slug && String(record.slug || "") !== filter.slug) return false;
  return true;
}

async function writeLastDeployStatus(record) {
  const payload = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    ...record,
  };
  await fsp.mkdir(SITES_ROOT, { recursive: true });
  await fsp.writeFile(LAST_DEPLOY_FILE, JSON.stringify(payload, null, 2));
}

async function readLastDeployStatus(filter = {}) {
  try {
    const record = JSON.parse(await fsp.readFile(LAST_DEPLOY_FILE, "utf-8"));
    return recordMatches(record, filter) ? record : null;
  } catch {
    return null;
  }
}

async function latestSuccessfulDeploy(filter = {}) {
  const candidates = [];
  const addFromWorkspace = async (wsDir, workspaceId) => {
    for (const file of ["current.json", "preview.json"]) {
      const manifest = await readManifestFile(wsDir, file);
      if (!manifest) continue;
      const enriched = {
        ok: true,
        status: "succeeded",
        phase: "served",
        workspaceId: manifest.workspaceId || workspaceId,
        slug: manifest.slug || null,
        channel: manifest.channel || (file === "current.json" ? "production" : "preview"),
        bucket: manifest.bucket || null,
        key: manifest.key || null,
        webRoot: manifest.webRoot || null,
        releaseDir: manifest.releaseDir || null,
        sizeBytes: manifest.sizeBytes ?? null,
        envInjected: Boolean(manifest.envInjected),
        unpack: { ok: true, servedAt: manifest.servedAt ?? null, durationMs: manifest.durationMs ?? null },
        migrationsApplied: manifest.migrations ?? manifest.migrationStatus?.applied ?? null,
        migrationStatus: manifest.migrationStatus ?? normalizeMigrations(manifest.migrations),
        servedAt: manifest.servedAt ?? null,
        finishedAt: manifest.servedAt ?? null,
      };
      if (recordMatches(enriched, filter)) candidates.push(enriched);
    }
  };

  if (filter.slug) {
    const r = await resolveSlug(filter.slug);
    if (r.ok) await addFromWorkspace(path.join(SITES_ROOT, r.workspaceId), r.workspaceId);
  } else if (filter.workspaceId) {
    await addFromWorkspace(path.join(SITES_ROOT, filter.workspaceId), filter.workspaceId);
  } else {
    try {
      const entries = await fsp.readdir(SITES_ROOT, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".")) {
          await addFromWorkspace(path.join(SITES_ROOT, e.name), e.name);
        }
      }
    } catch { /* no sites root yet */ }
  }

  candidates.sort((a, b) => deployStamp(b) - deployStamp(a));
  return candidates[0] ?? null;
}

async function sandboxHealth(filter = {}) {
  const lastAttempt = await readLastDeployStatus(filter);
  const lastSuccessful = await latestSuccessfulDeploy(filter);
  const lastDeploy = [lastAttempt, lastSuccessful].filter(Boolean).sort((a, b) => deployStamp(b) - deployStamp(a))[0] ?? null;
  let siteStatusResult = null;
  const slug = filter.slug || normalizeSlug(lastDeploy?.slug);
  if (slug) siteStatusResult = await siteStatus(slug);

  // Secret presence + source path — helps operators diagnose "which env file
  // did the worker actually load its shared secret from?" without exposing
  // the secret itself. secret_fingerprint is a short sha256 prefix so Lovable
  // Cloud can compare fingerprints against PLUTO_SANDBOX_SECRET.
  const secretPath = process.env.SANDBOX_SHARED_SECRET_PATH
    || (fs.existsSync("/etc/pluto/sandbox-worker.env") ? "/etc/pluto/sandbox-worker.env" : null);
  const secretFingerprint = SECRET
    ? createHash("sha256").update(SECRET).digest("hex").slice(0, 12)
    : null;

  const unpack = lastDeploy ? {
    ok: lastDeploy.ok === true,
    status: lastDeploy.status ?? (lastDeploy.ok ? "succeeded" : "unknown"),
    phase: lastDeploy.phase ?? null,
    workspaceId: lastDeploy.workspaceId ?? null,
    slug: lastDeploy.slug ?? null,
    channel: lastDeploy.channel ?? null,
    bucket: lastDeploy.bucket ?? null,
    key: lastDeploy.key ?? null,
    sizeBytes: lastDeploy.sizeBytes ?? null,
    startedAt: lastDeploy.startedAt ?? null,
    finishedAt: lastDeploy.finishedAt ?? lastDeploy.servedAt ?? null,
    durationMs: lastDeploy.durationMs ?? lastDeploy.unpack?.durationMs ?? null,
    error: lastDeploy.error ?? null,
  } : { ok: false, status: "missing", phase: null };

  const migrations = lastDeploy?.migrationStatus ?? normalizeMigrations(lastDeploy?.migrationsApplied ?? lastDeploy?.migrations) ?? null;

  return {
    ok: true,
    service: "pluto-sandbox-worker",
    version: "v1-static-serve-2026-07-17-public-diagnostics",
    features: {
      request_body_service_key: true,
      storage_workspace_header_preserves_uuid: true,
      served_site_diagnostics: true,
    },
    auth: { ok: true, method: "x-sandbox-secret" },
    // Flat operator-friendly fields (used by Auto Deploy preflight + docs).
    secret_present: Boolean(SECRET),
    secret_path: secretPath,
    secret_fingerprint: secretFingerprint,
    last_deploy_status: unpack.status,
    last_deploy_ok: unpack.ok === true,
    last_deploy_phase: unpack.phase,
    last_deploy_error: unpack.error,
    last_deploy_finished_at: unpack.finishedAt,
    migrations_status: (migrations && typeof migrations === "object" && "status" in migrations) ? migrations.status : (migrations ?? null),
    filter: { slug: filter.slug || null, workspaceId: filter.workspaceId || null },
    unpack,
    migrations,
    static: siteStatusResult ? {
      ok: Boolean(siteStatusResult.staticServing || siteStatusResult.previewServing),
      production: Boolean(siteStatusResult.staticServing),
      preview: Boolean(siteStatusResult.previewServing),
      ready: Boolean(siteStatusResult.ready),
      servedAt: siteStatusResult.servedAt ?? null,
    } : null,
    lastDeploy,
    lastSuccessfulDeploy: lastSuccessful,
    ts: new Date().toISOString(),
  };
}

async function fetchBundle(bucket, key, opts = {}) {
  const overrideKey = typeof opts.serviceKey === "string" && opts.serviceKey.trim() ? opts.serviceKey.trim() : "";
  const effectiveKey = overrideKey || SERVICE_KEY;
  if (!effectiveKey) throw new Error("PLUTO_SERVICE_ROLE_KEY is required for POST /unpack (and no serviceKey was supplied in the request body)");
  const url = `${UPSTREAM}/storage/v1/object/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const headers = { apikey: effectiveKey, authorization: `Bearer ${effectiveKey}` };
  if (opts.workspaceId) headers["x-workspace-id"] = String(opts.workspaceId);
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    // undici throws a generic TypeError('fetch failed') on ECONNREFUSED / DNS / TLS
    // errors. Surface the URL and root cause so operators can see the misconfig.
    const cause = e?.cause?.code || e?.cause?.message || e?.cause || e?.message || String(e);
    const hint = /127\.0\.0\.1|localhost/.test(UPSTREAM)
      ? ` — PLUTO_UPSTREAM_URL points at ${UPSTREAM}, which likely has no Supabase Storage listening. Set PLUTO_UPSTREAM_URL in /etc/pluto/sandbox-worker.env to your real Supabase project URL (e.g. https://<project-ref>.supabase.co) and restart the worker.`
      : "";
    throw new Error(`storage GET network error for ${url}: ${cause}${hint}`);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const source = overrideKey ? "request-body serviceKey" : "env PLUTO_SERVICE_ROLE_KEY";
    const hint = res.status === 401 || res.status === 403
      ? ` — the ${source} was rejected by ${UPSTREAM}. Ensure Lovable Cloud's PLUTO_SERVICE_ROLE_KEY matches the service-role key configured on the VPS storage backend, or that the caller passes a fresh serviceKey in the /unpack body.`
      : "";
    throw new Error(`storage GET HTTP ${res.status} from ${url}: ${body}${hint}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

function runUnzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const p = spawn("unzip", ["-oq", zipPath, "-d", destDir], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (b) => { err += b.toString(); });
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`unzip exit ${code}: ${err.slice(0, 200)}`)));
    p.on("error", reject);
  });
}

async function pickWebRoot(dir) {
  // If ZIP unpacked into a single subfolder that contains index.html, promote it.
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = path.join(dir, entries[0].name);
    const innerEntries = await fsp.readdir(inner);
    if (innerEntries.includes("index.html") || innerEntries.includes("dist") || innerEntries.includes("build")) return inner;
  }
  return dir;
}

async function findServable(root) {
  // Prefer common build output folders.
  for (const candidate of ["dist", "build", "public"]) {
    const p = path.join(root, candidate);
    try { const st = await fsp.stat(p); if (st.isDirectory()) return p; } catch { /* skip */ }
  }
  return root;
}

// Slug format must match src/lib/pluto/reserved-slugs.ts and migration 0034.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

async function ensureSlugSymlink(wsDir, slug) {
  if (!slug || !SLUG_RE.test(slug)) return null;
  const slugPath = path.join(SITES_ROOT, slug);
  // Reject if a real directory already sits there under a different owner.
  try {
    const st = await fsp.lstat(slugPath);
    if (st.isSymbolicLink()) {
      const target = await fsp.readlink(slugPath);
      const abs = path.isAbsolute(target) ? target : path.join(SITES_ROOT, target);
      if (path.resolve(abs) === path.resolve(wsDir)) return slugPath; // already correct
      await fsp.unlink(slugPath);
    } else if (st.isDirectory() && path.resolve(slugPath) === path.resolve(wsDir)) {
      // workspaceId and public slug are identical. Older workers treated this
      // as "not linked" because no symlink could be created over the directory.
      return slugPath;
    } else {
      // A concrete directory / file at this slug — refuse to clobber.
      return null;
    }
  } catch { /* not exist, fine */ }
  await fsp.symlink(path.relative(SITES_ROOT, wsDir), slugPath);
  return slugPath;
}

// Phase C — write /env.js so window.__PLUTO_ENV__ = {...} is available to the
// deployed bundle before its main script runs. Keys are validated against the
// same shape enforced by admin.project_env (uppercase alnum + underscore).
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,62}$/;
function serializeEnvJs(envObj) {
  const clean = {};
  for (const [k, v] of Object.entries(envObj || {})) {
    // Accept the reserved lowercase runtime keys (url/anonKey/serviceKey/browserUrl)
    // AND admin.project_env-style UPPER_SNAKE keys.
    if (/^(url|anonKey|serviceKey|browserUrl)$/.test(k) || ENV_KEY_RE.test(k)) {
      clean[k] = String(v ?? "");
    }
  }
  // JSON.stringify escaping is sufficient — no </script> risk in JSON.
  return `window.__PLUTO_ENV__ = ${JSON.stringify(clean)};\n`;
}

// Phase E — channel routing:
//   "preview"    → symlink `preview`  (served on <slug>-dev.app.<apex>)
//   "production" → symlink `current`  (served on <slug>.app.<apex>)
// Default channel is "preview" so unpacks never auto-publish; a separate
// /publish call flips preview → current atomically.
const VALID_CHANNELS = new Set(["preview", "production"]);
function channelLinkName(ch) { return ch === "production" ? "current" : "preview"; }

async function atomicSymlink(linkPath, targetRelPath) {
  const tmp = `${linkPath}.tmp-${randomUUID().slice(0, 6)}`;
  await fsp.symlink(targetRelPath, tmp);
  await fsp.rename(tmp, linkPath);
}

async function unpack({ workspaceId, slug, bucket, key, env, channel, migrations, serviceKey }) {
  // Keep two workspace forms:
  //   rawWorkspaceId  → auth/storage routing header (must preserve UUID hyphens)
  //   ws              → filesystem-safe directory name
  // Older code reused the filesystem-safe value for x-workspace-id, turning
  // UUIDs like 061c...-... into 061c..._..., which made Storage reject GETs
  // with 401 even though the same service key had just uploaded the bundle.
  const rawWorkspaceId = String(workspaceId ?? "").trim();
  const ws = safeSlug(rawWorkspaceId);
  if (!ws) throw new Error("invalid workspaceId");
  if (!bucket || !key) throw new Error("bucket and key are required");
  const normalizedSlug = typeof slug === "string" ? slug.trim().toLowerCase() : "";
  if (normalizedSlug && !SLUG_RE.test(normalizedSlug)) throw new Error("invalid slug");
  const ch = VALID_CHANNELS.has(channel) ? channel : "preview";

  const started = Date.now();
  const wsRoot = path.join(SITES_ROOT, ws);
  await fsp.mkdir(wsRoot, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const releaseDir = path.join(wsRoot, `release-${stamp}-${randomUUID().slice(0, 8)}`);
  await fsp.mkdir(releaseDir, { recursive: true });

  const zipBytes = await fetchBundle(bucket, key, { serviceKey, workspaceId: rawWorkspaceId || ws });
  const zipPath = path.join(wsRoot, `bundle-${stamp}.zip`);
  await fsp.writeFile(zipPath, zipBytes);

  await runUnzip(zipPath, releaseDir);
  await fsp.unlink(zipPath).catch(() => {});

  const promoted = await pickWebRoot(releaseDir);
  const webRoot = await findServable(promoted);

  // Inject runtime env into the release BEFORE the atomic flip.
  let envInjected = false;
  if (env && typeof env === "object") {
    await fsp.writeFile(path.join(webRoot, "env.js"), serializeEnvJs(env));
    envInjected = true;
  }

  // Atomic symlink flip for the requested channel only.
  const channelLink = path.join(wsRoot, channelLinkName(ch));
  await atomicSymlink(channelLink, path.relative(wsRoot, webRoot));

  // Slug → workspace symlink so nginx wildcard can resolve <slug>.app.<apex>.
  const slugLink = normalizedSlug ? await ensureSlugSymlink(wsRoot, normalizedSlug) : null;

  const manifest = {
    workspaceId: ws,
    slug: normalizedSlug || null,
    slugLink,
    channel: ch,
    envInjected,
    bucket,
    key,
    releaseDir,
    webRoot,
    servedAt: new Date().toISOString(),
    sizeBytes: zipBytes.length,
    durationMs: Date.now() - started,
    migrations: normalizeMigrations(migrations)?.applied ?? normalizeMigrations(migrations)?.count ?? null,
    migrationStatus: normalizeMigrations(migrations),
  };
  // Per-channel manifest, plus a legacy `current.json` that mirrors the
  // last write (backward compat with earlier /status callers).
  await fsp.writeFile(path.join(wsRoot, `${channelLinkName(ch)}.json`), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(wsRoot, "current.json"), JSON.stringify(manifest, null, 2));

  // Prune old releases (keep 5 most recent).
  const releases = (await fsp.readdir(wsRoot, { withFileTypes: true }))
    .filter(d => d.isDirectory() && d.name.startsWith("release-"))
    .map(d => d.name).sort().reverse();
  for (const old of releases.slice(5)) {
    await fsp.rm(path.join(wsRoot, old), { recursive: true, force: true }).catch(() => {});
  }

  return manifest;
}

// Phase E — publish: flip preview → current atomically. Idempotent.
async function publish({ workspaceId, slug }) {
  let wsDir;
  if (slug) {
    const r = await resolveSlug(slug);
    if (!r.ok) throw new Error(r.error);
    wsDir = path.join(SITES_ROOT, r.workspaceId);
  } else if (workspaceId) {
    wsDir = path.join(SITES_ROOT, safeSlug(workspaceId));
  } else {
    throw new Error("slug or workspaceId is required");
  }
  const previewLink = path.join(wsDir, "preview");
  const previewReal = await fsp.realpath(previewLink).catch(() => null);
  if (!previewReal) throw new Error("no preview build to publish");
  const currentLink = path.join(wsDir, "current");
  await atomicSymlink(currentLink, path.relative(wsDir, previewReal));
  const publishedAt = new Date().toISOString();
  // Copy preview manifest → current manifest, stamping channel.
  try {
    const raw = await fsp.readFile(path.join(wsDir, "preview.json"), "utf-8");
    const m = { ...JSON.parse(raw), channel: "production", publishedAt };
    await fsp.writeFile(path.join(wsDir, "current.json"), JSON.stringify(m, null, 2));
  } catch { /* no preview manifest — that's fine */ }
  return { ok: true, publishedAt, target: previewReal };
}

// Phase E — unpublish: remove the `current` symlink so <slug>.app returns
// the "not deployed" page while the preview stays live for the owner.
async function unpublish({ workspaceId, slug }) {
  let wsDir;
  if (slug) {
    const r = await resolveSlug(slug);
    if (!r.ok) throw new Error(r.error);
    wsDir = path.join(SITES_ROOT, r.workspaceId);
  } else if (workspaceId) {
    wsDir = path.join(SITES_ROOT, safeSlug(workspaceId));
  } else {
    throw new Error("slug or workspaceId is required");
  }
  await fsp.unlink(path.join(wsDir, "current")).catch(() => {});
  await fsp.unlink(path.join(wsDir, "current.json")).catch(() => {});
  return { ok: true, unpublishedAt: new Date().toISOString() };
}

async function resolveSlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s || !SLUG_RE.test(s)) return { ok: false, error: "invalid slug" };
  const slugPath = path.join(SITES_ROOT, s);
  try {
    const st = await fsp.lstat(slugPath);
    let wsDir;
    if (st.isSymbolicLink()) {
      const target = await fsp.readlink(slugPath);
      wsDir = path.isAbsolute(target) ? target : path.join(SITES_ROOT, target);
    } else if (st.isDirectory()) {
      // Accept /var/lib/pluto/sites/<slug>/ when workspaceId === slug.
      wsDir = slugPath;
    } else {
      return { ok: false, error: "slug not linked" };
    }
    const workspaceId = path.basename(wsDir);
    let manifest = null;
    try { manifest = JSON.parse(await fsp.readFile(path.join(wsDir, "current.json"), "utf-8")); } catch { /* no bundle yet */ }
    return { ok: true, slug: s, workspaceId, servedAt: manifest?.servedAt ?? null, sizeBytes: manifest?.sizeBytes ?? null };
  } catch {
    return { ok: false, error: "slug not found" };
  }
}

// Hot env rotation — rewrite env.js in the live `current/` dir without a redeploy.
async function rotateEnv({ workspaceId, slug, env, merge }) {
  let wsDir;
  if (slug) {
    const r = await resolveSlug(slug);
    if (!r.ok) throw new Error(r.error);
    wsDir = path.join(SITES_ROOT, r.workspaceId);
  } else if (workspaceId) {
    wsDir = path.join(SITES_ROOT, safeSlug(workspaceId));
  } else {
    throw new Error("slug or workspaceId is required");
  }
  const currentLink = path.join(wsDir, "current");
  const currentReal = await fsp.realpath(currentLink).catch(() => null);
  if (!currentReal) throw new Error("no current release to update");

  const envPath = path.join(currentReal, "env.js");
  let next = env && typeof env === "object" ? { ...env } : {};
  if (merge) {
    // Best-effort merge — parse existing env.js by evaluating in a sandbox-safe way:
    // we only support the exact shape we write, so a regex extraction is enough.
    try {
      const existing = await fsp.readFile(envPath, "utf-8");
      const m = existing.match(/window\.__PLUTO_ENV__\s*=\s*(\{[\s\S]*?\});?/);
      if (m) next = { ...JSON.parse(m[1]), ...next };
    } catch { /* no prior env.js — treat as empty */ }
  }
  await fsp.writeFile(envPath, serializeEnvJs(next));
  return { ok: true, envPath, keys: Object.keys(next).sort() };
}

async function status(workspaceId) {
  const wsRoot = path.join(SITES_ROOT, safeSlug(workspaceId));
  try {
    const raw = await fsp.readFile(path.join(wsRoot, "current.json"), "utf-8");
    return { ok: true, ...JSON.parse(raw) };
  } catch {
    return { ok: false, error: "no bundle served yet" };
  }
}

// ---------- Public static serving (no shared secret) ----------
// GET /sites/<slug>/*  — serves the workspace's `current` symlink content.
// GET /preview/<slug>/* — serves the workspace's `preview` symlink content.
// Nginx can either proxy these paths directly (location /sites/) or terminate
// wildcard hostnames like <slug>.app.<apex> and proxy_pass to /sites/<slug>/.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map":  "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif":  "image/gif",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".txt":  "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

// Detect fingerprinted assets (Vite emits /assets/*-<hash>.js). These are
// safe to cache forever with `immutable`.
const HASHED_ASSET_RE = /-[a-f0-9]{8,}\.(?:js|mjs|css|woff2?|png|jpg|jpeg|webp|gif|svg|ico|map|wasm)$/i;
function cacheControlFor(ext, filePath) {
  if (ext === ".html" || ext === ".htm") return "no-cache";
  if (HASHED_ASSET_RE.test(filePath)) return "public, max-age=31536000, immutable";
  return "public, max-age=3600, must-revalidate";
}
function weakEtag(stat) {
  // Cheap ETag: size + mtime. Weak (W/) because it is not a byte hash.
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}
function strongEtagFromBuffer(buf) {
  return `"${createHash("sha1").update(buf).digest("base64").slice(0, 22)}"`;
}

async function serveStatic(req, res, wsDir, linkName, relPath) {
  // Resolve wsDir/<linkName> → real release dir, then join relPath safely.
  let baseDir;
  try { baseDir = await fsp.realpath(path.join(wsDir, linkName)); }
  catch { return json(res, 404, { error: "not_deployed", channel: linkName }); }

  const clean = decodeURIComponent(relPath || "").replace(/^\/+/, "");
  const requested = path.resolve(baseDir, clean);
  if (!requested.startsWith(baseDir)) return json(res, 400, { error: "bad_path" });

  let filePath = requested;
  try {
    const st = await fsp.stat(filePath);
    if (st.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch { /* fall through — SPA fallback below */ }

  try {
    const st = await fsp.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    const etag = weakEtag(st);
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && inm === etag) {
      res.writeHead(304, { etag, "cache-control": cacheControlFor(ext, filePath) });
      return res.end();
    }
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      "content-type": type,
      "content-length": data.length,
      "cache-control": cacheControlFor(ext, filePath),
      "last-modified": new Date(st.mtimeMs).toUTCString(),
      etag,
      vary: "Accept-Encoding",
    });
    return res.end(data);
  } catch {
    // SPA fallback → index.html at the release root.
    try {
      const idx = await fsp.readFile(path.join(baseDir, "index.html"));
      const etag = strongEtagFromBuffer(idx);
      const inm = req.headers["if-none-match"];
      if (typeof inm === "string" && inm === etag) {
        res.writeHead(304, { etag, "cache-control": "no-cache" });
        return res.end();
      }
      res.writeHead(200, {
        "content-type": MIME[".html"],
        "content-length": idx.length,
        "cache-control": "no-cache",
        etag,
        vary: "Accept-Encoding",
      });
      return res.end(idx);
    } catch {
      return json(res, 404, { error: "not_found" });
    }
  }
}

async function handleStatic(req, res, prefix, linkName) {
  // /sites/<slug>[/<rest>]
  const rest = req.url.slice(prefix.length);
  const m = rest.match(/^\/?([^/?#]+)(?:\/([^?#]*))?/);
  if (!m) return json(res, 404, { error: "bad_url" });
  const slug = String(m[1] || "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return json(res, 404, { error: "invalid_slug" });
  const r = await resolveSlug(slug);
  if (!r.ok) return json(res, 404, { error: r.error });
  const wsDir = path.join(SITES_ROOT, r.workspaceId);
  return serveStatic(req, res, wsDir, linkName, m[2] || "");
}

// Public readiness endpoint — no shared secret. Answers "is <slug> ready to serve?"
// Reports: bundle upload (zip fetched + unpacked), migration status (best-effort
// from manifest.migrations if the deployer wrote it), and static serving state.
async function siteStatus(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s || !SLUG_RE.test(s)) return { ok: false, error: "invalid_slug" };
  const slugPath = path.join(SITES_ROOT, s);
  let workspaceId = null;
  try {
    const st = await fsp.lstat(slugPath);
    let wsDir;
    if (st.isSymbolicLink()) {
      const target = await fsp.readlink(slugPath);
      wsDir = path.isAbsolute(target) ? target : path.join(SITES_ROOT, target);
    } else if (st.isDirectory()) {
      wsDir = slugPath;
    } else {
      return { ok: false, slug: s, error: "slug_not_linked",
               bundleUploaded: false, migrationsApplied: null, staticServing: false };
    }
    workspaceId = path.basename(wsDir);
    const readManifest = async (name) => {
      try { return JSON.parse(await fsp.readFile(path.join(wsDir, name), "utf-8")); }
      catch { return null; }
    };
    const current = await readManifest("current.json");
    const preview = await readManifest("preview.json");
    const anyManifest = current || preview;
    // Confirm the current symlink resolves to a real directory with index.html.
    let staticServing = false;
    try {
      const real = await fsp.realpath(path.join(wsDir, "current"));
      const idx = await fsp.stat(path.join(real, "index.html"));
      staticServing = idx.isFile();
    } catch { /* not deployed to production channel yet */ }
    let previewServing = false;
    try {
      const real = await fsp.realpath(path.join(wsDir, "preview"));
      const idx = await fsp.stat(path.join(real, "index.html"));
      previewServing = idx.isFile();
    } catch { /* no preview */ }
    return {
      ok: true,
      slug: s,
      workspaceId,
      bundleUploaded: Boolean(anyManifest),
      migrationsApplied: anyManifest?.migrations ?? null, // filled by deployer if wired
      staticServing,
      previewServing,
      channel: staticServing ? "production" : (previewServing ? "preview" : "none"),
      servedAt: current?.servedAt ?? preview?.servedAt ?? null,
      sizeBytes: current?.sizeBytes ?? preview?.sizeBytes ?? null,
      envInjected: Boolean(anyManifest?.envInjected),
      ready: Boolean(staticServing),
      ts: new Date().toISOString(),
    };
  } catch {
    return { ok: false, slug: s, error: "slug_not_found",
             bundleUploaded: false, migrationsApplied: null, staticServing: false };
  }
}

async function readTextFile(file) {
  try { return await fsp.readFile(file, "utf-8"); }
  catch { return ""; }
}

async function scanNginxDir(dir, baseDomain) {
  const hosts = new Set();
  let wildcard = false;
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const text = await readTextFile(file);
      if (!text) continue;
      if (text.includes(baseDomain) && (/proxy_pass\s+http:\/\/127\.0\.0\.1:8787\/sites\//.test(text) || /server_name\s+~\^/.test(text))) {
        wildcard = true;
      }
      const re = /server_name\s+([^;]+);/g;
      let m;
      while ((m = re.exec(text))) {
        for (const raw of String(m[1] || "").split(/\s+/)) {
          const host = raw.trim().replace(/^\*\./, "").replace(/[;{}]/g, "").toLowerCase();
          if (!host || host === "_" || host.startsWith("~")) continue;
          if (host === baseDomain || host.endsWith(`.${baseDomain}`)) hosts.add(host);
        }
      }
    }
  } catch { /* nginx dir absent */ }
  return { hosts, wildcard };
}

async function localProbe(protocol, host) {
  const started = Date.now();
  const isHttps = protocol === "https";
  const mod = isHttps ? https : http;
  return await new Promise((resolve) => {
    const req = mod.request({
      hostname: "127.0.0.1",
      port: isHttps ? 443 : 80,
      path: "/",
      method: "GET",
      servername: host,
      rejectUnauthorized: false,
      headers: { host, accept: "text/html,*/*" },
      timeout: 8_000,
    }, (r) => {
      r.resume();
      r.on("end", () => resolve({ status: r.statusCode || 0, latencyMs: Date.now() - started }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, latencyMs: Date.now() - started, error: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, latencyMs: Date.now() - started, error: e?.message ?? String(e) }));
    req.end();
  });
}

function certNameMatches(host, name) {
  const h = String(host || "").toLowerCase();
  const n = String(name || "").toLowerCase();
  if (!h || !n) return false;
  if (n.startsWith("*.")) return h.endsWith(n.slice(1)) && h.split(".").length === n.split(".").length;
  return h === n;
}

async function inspectLocalSsl(host) {
  return await new Promise((resolve) => {
    const socket = tls.connect({ host: "127.0.0.1", port: 443, servername: host, rejectUnauthorized: false, timeout: 8_000 }, () => {
      try {
        const c = socket.getPeerCertificate(false);
        if (!c || Object.keys(c).length === 0) {
          socket.destroy();
          return resolve({ valid: false, cn: null, expiry: null, daysLeft: null, hostnameMatch: false, warning: "no_certificate" });
        }
        const validTo = c.valid_to ? new Date(c.valid_to) : null;
        const daysLeft = validTo ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000) : null;
        const cn = typeof c.subject?.CN === "string" ? c.subject.CN : (Array.isArray(c.subject?.CN) ? String(c.subject.CN[0]) : null);
        const sans = String(c.subjectaltname || "").split(/,\s*/).map((s) => s.replace(/^DNS:/, "").trim()).filter(Boolean);
        const hostnameMatch = Boolean((cn && certNameMatches(host, cn)) || sans.some((n) => certNameMatches(host, n)));
        const valid = Boolean(daysLeft != null && daysLeft >= 0 && hostnameMatch);
        socket.destroy();
        resolve({ valid, cn, expiry: c.valid_to || null, daysLeft, hostnameMatch, warning: daysLeft != null && daysLeft <= 30 ? "expires_soon" : null });
      } catch (e) {
        socket.destroy();
        resolve({ valid: false, cn: null, expiry: null, daysLeft: null, hostnameMatch: false, warning: e?.message ?? "inspect_failed" });
      }
    });
    socket.on("error", (e) => resolve({ valid: false, cn: null, expiry: null, daysLeft: null, hostnameMatch: false, warning: e?.message ?? "tls_error" }));
    socket.on("timeout", () => { socket.destroy(); resolve({ valid: false, cn: null, expiry: null, daysLeft: null, hostnameMatch: false, warning: "timeout" }); });
  });
}

async function listActiveSubdomains(baseDomainInput = DEFAULT_BASE_DOMAIN) {
  const baseDomain = safeDomain(baseDomainInput);
  const enabled = await scanNginxDir(NGINX_SITES_ENABLED, baseDomain);
  const available = await scanNginxDir(NGINX_SITES_AVAILABLE, baseDomain);
  const hosts = new Set([...enabled.hosts, ...available.hosts]);
  try {
    const entries = await fsp.readdir(SITES_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const slug = e.name.toLowerCase();
      if (SLUG_RE.test(slug)) hosts.add(`${slug}.${baseDomain}`);
    }
  } catch { /* sites root absent */ }

  const rows = [];
  for (const host of [...hosts].sort()) {
    const suffix = `.${baseDomain}`;
    const rawSlug = host.endsWith(suffix) ? host.slice(0, -suffix.length) : host;
    const slug = rawSlug.endsWith("-dev") ? rawSlug.slice(0, -4) : rawSlug;
    const status = SLUG_RE.test(slug) ? await siteStatus(slug) : { ok: false, ready: false, error: "invalid_slug" };
    const httpProbe = await localProbe("http", host);
    const httpsProbe = await localProbe("https", host);
    const ssl = await inspectLocalSsl(host);
    const nginxEnabled = enabled.hosts.has(host) || enabled.wildcard;
    const nginxAvailable = available.hosts.has(host) || available.wildcard;
    const issues = [];
    if (!nginxEnabled) issues.push("nginx_not_enabled");
    if (!status.ready) issues.push(status.error || "site_not_ready");
    if (!ssl.valid) issues.push("ssl_invalid");
    if (ssl.daysLeft != null && ssl.daysLeft <= 30) issues.push("ssl_expiring_soon");
    rows.push({
      host,
      slug,
      url: `https://${host}/`,
      nginx: { enabled: nginxEnabled, available: nginxAvailable, wildcardEnabled: enabled.wildcard, wildcardAvailable: available.wildcard },
      worker: { ok: Boolean(status.ok), ready: Boolean(status.ready), channel: status.channel || null, servedAt: status.servedAt || null, error: status.error || null },
      http: httpProbe,
      https: httpsProbe,
      ssl,
      issues,
      ok: nginxEnabled && Boolean(status.ready) && ssl.valid && httpsProbe.status >= 200 && httpsProbe.status < 500,
    });
  }
  const expiringSoon = rows.filter((r) => r.ssl?.daysLeft != null && r.ssl.daysLeft <= 30).length;
  return {
    ok: rows.every((r) => r.ok),
    baseDomain,
    checkedAt: new Date().toISOString(),
    count: rows.length,
    summary: {
      ready: rows.filter((r) => r.ok).length,
      nginxEnabled: rows.filter((r) => r.nginx.enabled).length,
      sslValid: rows.filter((r) => r.ssl.valid).length,
      expiringSoon,
      broken: rows.filter((r) => !r.ok).length,
    },
    subdomains: rows,
  };
}

async function pathExists(p, kind = "any") {
  try {
    const st = await fsp.lstat(p);
    if (kind === "directory") return st.isDirectory();
    if (kind === "file") return st.isFile();
    if (kind === "symlink") return st.isSymbolicLink();
    return true;
  } catch {
    return false;
  }
}

async function symlinkInfo(p) {
  try {
    const st = await fsp.lstat(p);
    if (!st.isSymbolicLink()) return { exists: true, isSymlink: false, target: null, resolved: null };
    const target = await fsp.readlink(p);
    let resolved = null;
    try { resolved = await fsp.realpath(p); } catch { resolved = path.resolve(path.dirname(p), target); }
    return { exists: true, isSymlink: true, target, resolved };
  } catch {
    return { exists: false, isSymlink: false, target: null, resolved: null };
  }
}

async function servedSiteDiagnostics(workspaceIdInput, slugInput) {
  const slug = normalizeSlug(slugInput);
  const workspaceId = safeSlug(workspaceIdInput || "");
  const errors = [];
  if (!workspaceId) errors.push("workspaceId_missing");
  if (!slug) errors.push("invalid_slug");

  const workspaceDir = path.join(SITES_ROOT, workspaceId || "_");
  const slugPath = path.join(SITES_ROOT, slug || "_");
  const nestedSlugPath = path.join(workspaceDir, slug || "_");
  const currentLink = path.join(workspaceDir, "current");
  const currentJsonPath = path.join(workspaceDir, "current.json");
  const siteStatusResult = slug ? await siteStatus(slug) : { ok: false, error: "invalid_slug" };

  const workspaceDirExists = await pathExists(workspaceDir, "directory");
  if (!workspaceDirExists) errors.push("workspace_dir_missing");

  const slugInfo = await symlinkInfo(slugPath);
  const nestedSlugInfo = await symlinkInfo(nestedSlugPath);
  const currentInfo = await symlinkInfo(currentLink);

  const workspaceReal = workspaceDirExists ? await fsp.realpath(workspaceDir).catch(() => path.resolve(workspaceDir)) : path.resolve(workspaceDir);
  const slugTargetsWorkspace = Boolean(slugInfo.resolved && path.resolve(slugInfo.resolved) === path.resolve(workspaceReal));
  if (!slugInfo.exists) errors.push("top_level_slug_mapping_missing");
  else if (!slugTargetsWorkspace && path.resolve(slugPath) !== path.resolve(workspaceDir)) errors.push("top_level_slug_mapping_wrong_target");

  const currentJsonExists = await pathExists(currentJsonPath, "file");
  let currentJson = null;
  let currentJsonValid = false;
  if (currentJsonExists) {
    try {
      currentJson = JSON.parse(await fsp.readFile(currentJsonPath, "utf-8"));
      currentJsonValid = true;
    } catch {
      errors.push("current_json_invalid");
    }
  } else {
    errors.push("current_json_missing");
  }

  const currentIndexExists = currentInfo.resolved
    ? await pathExists(path.join(currentInfo.resolved, "index.html"), "file")
    : false;
  if (!currentInfo.exists) errors.push("current_symlink_missing");
  if (currentInfo.exists && !currentInfo.isSymlink) errors.push("current_is_not_symlink");
  if (currentInfo.exists && currentInfo.isSymlink && !currentIndexExists) errors.push("current_index_missing");

  const currentJsonSlug = currentJsonValid && typeof currentJson?.slug === "string" ? currentJson.slug : null;
  const currentJsonWorkspaceId = currentJsonValid && typeof currentJson?.workspaceId === "string" ? currentJson.workspaceId : null;
  const currentJsonWebRoot = currentJsonValid && typeof currentJson?.webRoot === "string" ? currentJson.webRoot : null;
  const currentJsonMatchesSlug = currentJsonValid ? currentJsonSlug === slug : null;
  const currentJsonMatchesWorkspace = currentJsonValid ? currentJsonWorkspaceId === workspaceId : null;
  if (currentJsonValid && !currentJsonMatchesSlug) errors.push("current_json_slug_mismatch");
  if (currentJsonValid && !currentJsonMatchesWorkspace) errors.push("current_json_workspace_mismatch");

  return {
    ok: errors.length === 0,
    slug,
    workspaceId,
    checkedAt: new Date().toISOString(),
    paths: {
      sitesRoot: SITES_ROOT,
      workspaceDir,
      workspaceDirExists,
      slugPath,
      slugPathExists: slugInfo.exists,
      slugIsSymlink: slugInfo.isSymlink,
      slugTarget: slugInfo.target,
      slugTargetResolved: slugInfo.resolved,
      slugTargetsWorkspace,
      nestedSlugPath,
      nestedSlugPathExists: nestedSlugInfo.exists,
      nestedSlugIsSymlink: nestedSlugInfo.isSymlink,
      nestedSlugTarget: nestedSlugInfo.target,
      currentLink,
      currentExists: currentInfo.exists,
      currentIsSymlink: currentInfo.isSymlink,
      currentTarget: currentInfo.target,
      currentTargetResolved: currentInfo.resolved,
      currentIndexExists,
      currentJsonPath,
      currentJsonExists,
      currentJsonValid,
      currentJsonSlug,
      currentJsonWorkspaceId,
      currentJsonWebRoot,
      currentJsonMatchesSlug,
      currentJsonMatchesWorkspace,
      errors,
    },
    siteStatus: siteStatusResult,
    hint: errors.length ? `Fix: ${errors.join(", ")}` : "Site mapping is consistent; check nginx/DNS/TLS if the public URL still fails.",
  };
}

// Minimal in-process placeholder seeder — mirrors deploy/seed-slug.sh so the
// worker can self-heal when /site-status/<slug> is asked for a slug that has
// no bundle yet.
async function seedPlaceholder(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!SLUG_RE.test(s)) throw new Error("invalid_slug");
  const wsDir = path.join(SITES_ROOT, s);
  const ts = new Date().toISOString().replace(/[-:.]/g, "");
  const rel = `seed-${ts}`;
  const relDir = path.join(wsDir, rel);
  await fsp.mkdir(relDir, { recursive: true });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${s} — placeholder</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem;background:#0b1220;color:#e6edf7}
.box{max-width:640px;margin:10vh auto;background:#111a2e;padding:2rem;border-radius:12px}
code{background:#1c2740;padding:.15rem .4rem;border-radius:4px}</style></head>
<body><div class="box"><h1>✓ Sandbox is live</h1>
<p>Slug: <code>${s}</code></p>
<p>Auto-seeded placeholder. Run Auto Deploy from the dashboard to replace with real build.</p>
<p>Seeded: ${ts}</p></div></body></html>`;
  await fsp.writeFile(path.join(relDir, "index.html"), html);
  await fsp.writeFile(path.join(relDir, "env.js"), "window.__PLUTO_ENV__ = window.__PLUTO_ENV__ || {};\n");
  const manifest = {
    workspaceId: s, slug: s, channel: "production",
    release: rel, servedAt: ts, sizeBytes: Buffer.byteLength(html),
    placeholder: true, autoSeeded: true,
  };
  await fsp.writeFile(path.join(wsDir, "current.json"), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(wsDir, "preview.json"), JSON.stringify({ ...manifest, channel: "preview" }, null, 2));
  await atomicSymlink(path.join(wsDir, "current"), rel);
  await atomicSymlink(path.join(wsDir, "preview"), rel);
  return manifest;
}

const server = http.createServer(async (req, res) => {
  try {
    const p = requestPath(req);
    const q = requestQuery(req);
    if (req.method === "GET" && p === "/healthz") {
      // Detailed liveness — safe to expose publicly (no secrets, no PII).
      let siteCount = 0; let slugCount = 0; let lastServedAt = null;
      try {
        const entries = await fsp.readdir(SITES_ROOT, { withFileTypes: true });
        for (const e of entries) {
          if (e.isSymbolicLink()) slugCount++;
          else if (e.isDirectory()) {
            siteCount++;
            try {
              const m = JSON.parse(await fsp.readFile(path.join(SITES_ROOT, e.name, "current.json"), "utf-8"));
              if (!lastServedAt || (m.servedAt && m.servedAt > lastServedAt)) lastServedAt = m.servedAt;
            } catch { /* skip */ }
          }
        }
      } catch { /* SITES_ROOT missing */ }
      const mem = process.memoryUsage();
      return json(res, 200, {
        ok: true,
        service: "pluto-sandbox-worker",
        version: "v1-static-serve-2026-07-17-public-diagnostics",
        features: {
          request_body_service_key: true,
          storage_workspace_header_preserves_uuid: true,
          served_site_diagnostics: true,
          active_subdomains_api: true,
          ssl_expiry_precheck: true,
        },
        uptimeSec: Math.round(process.uptime()),
        sitesRoot: SITES_ROOT,
        workspaces: siteCount,
        slugs: slugCount,
        lastServedAt,
        memoryMB: { rss: Math.round(mem.rss / 1e6), heapUsed: Math.round(mem.heapUsed / 1e6) },
        upstream: UPSTREAM,
        nodeVersion: process.version,
        pid: process.pid,
        ts: new Date().toISOString(),
      });
    }
    // Public static routes — no shared secret, safe to expose behind nginx.
    if (req.method === "GET" && p.startsWith("/sites/")) {
      return handleStatic(req, res, "/sites/", "current");
    }
    if (req.method === "GET" && p.startsWith("/preview/")) {
      return handleStatic(req, res, "/preview/", "preview");
    }
    // Public readiness endpoint — no secret required.
    if (req.method === "GET" && p.startsWith("/site-status/")) {
      const rawSlug = p.slice("/site-status/".length);
      const s = decodeURIComponent(rawSlug || "");
      let r = await siteStatus(s);
      // Auto-seed placeholder when a trusted probe asks for it. Prevents the
      // "verify-deploy → 404 → run seed-slug.sh by hand" loop.
      if (!r.ok && (r.error === "slug_not_found" || r.error === "slug_not_linked")) {
        const wantsSeed = q.get("autoseed") === "1"
          || req.headers["x-pluto-auto-seed"] === "1";
        if (wantsSeed && SLUG_RE.test(String(s || "").toLowerCase())) {
          try {
            await seedPlaceholder(String(s).toLowerCase());
            r = await siteStatus(s);
            if (r.ok) r.autoSeeded = true;
          } catch (e) {
            return json(res, 500, { ok: false, error: "auto_seed_failed", detail: e?.message ?? String(e) });
          }
        }
      }
      return json(res, r.ok ? 200 : 404, r);
    }


    // Public read-only diagnostics — reports symlink/current.json presence only.
    if (req.method === "GET" && ["/diagnostics", "/sandbox/diagnostics", "/site-diagnostics", "/sandbox/site-diagnostics"].includes(p)) {
      return json(res, 200, await servedSiteDiagnostics(q.get("workspaceId"), q.get("slug")));
    }

    if (!checkSecret(req)) return json(res, 401, { error: "invalid or missing x-sandbox-secret" });

    if (req.method === "GET" && (p === "/health" || p === "/sandbox/health")) {
      const slug = normalizeSlug(q.get("slug"));
      const workspaceId = q.get("workspaceId") ? safeSlug(q.get("workspaceId")) : "";
      return json(res, 200, await sandboxHealth({ slug, workspaceId }));
    }

    // Authenticated JSON API for dashboards/automation:
    // GET /admin/subdomains?baseDomain=app.timescard.cloud
    // Returns active subdomains, nginx enable state, local HTTP/HTTPS probes,
    // and SSL validity with a 30-day expiring-soon summary.
    if (req.method === "GET" && (p === "/admin/subdomains" || p === "/sandbox/admin/subdomains")) {
      return json(res, 200, await listActiveSubdomains(q.get("baseDomain") || DEFAULT_BASE_DOMAIN));
    }



    if (req.method === "POST" && p === "/unpack") {
      const body = await readJson(req);
      const startedAt = new Date().toISOString();
      const recordBase = {
        ok: false,
        status: "running",
        phase: "unpack",
        startedAt,
        workspaceId: safeSlug(body?.workspaceId || ""),
        slug: normalizeSlug(body?.slug),
        channel: VALID_CHANNELS.has(body?.channel) ? body.channel : "preview",
        bucket: body?.bucket || null,
        key: body?.key || null,
        migrationStatus: normalizeMigrations(body?.migrations),
      };
      await writeLastDeployStatus(recordBase).catch(() => {});
      let m;
      try {
        m = await unpack(body);
        await writeLastDeployStatus({
          ...recordBase,
          ...m,
          ok: true,
          status: "succeeded",
          phase: "served",
          startedAt,
          finishedAt: new Date().toISOString(),
          migrationStatus: m.migrationStatus ?? recordBase.migrationStatus,
        }).catch(() => {});
      } catch (e) {
        await writeLastDeployStatus({
          ...recordBase,
          ok: false,
          status: "failed",
          phase: "unpack",
          finishedAt: new Date().toISOString(),
          error: e?.message ?? String(e),
        }).catch(() => {});
        throw e;
      }
      return json(res, 200, { ok: true, ...m });
    }
    // Authenticated placeholder seeder — dashboard "Heal" button calls this.
    if (req.method === "POST" && p === "/admin/seed-slug") {
      const body = await readJson(req).catch(() => ({}));
      const slug = body?.slug;
      if (!slug || !SLUG_RE.test(String(slug).toLowerCase())) {
        return json(res, 400, { ok: false, error: "invalid_slug" });
      }
      const m = await seedPlaceholder(String(slug).toLowerCase());
      return json(res, 200, { ok: true, ...m });
    }
    const statusMatch = req.method === "GET" && p.startsWith("/status/");
    if (statusMatch) {
      const ws = decodeURIComponent(p.slice("/status/".length));
      return json(res, 200, await status(ws));
    }
    const resolveMatch = req.method === "GET" && p.startsWith("/resolve/");
    if (resolveMatch) {
      const s = decodeURIComponent(p.slice("/resolve/".length));
      return json(res, 200, await resolveSlug(s));
    }
    if (req.method === "POST" && p === "/env") {
      const body = await readJson(req);
      const r = await rotateEnv(body);
      return json(res, 200, r);
    }
    if (req.method === "POST" && p === "/publish") {
      const r = await publish(await readJson(req));
      return json(res, 200, r);
    }
    if (req.method === "POST" && p === "/unpublish") {
      const r = await unpublish(await readJson(req));
      return json(res, 200, r);
    }
    // POST /admin/repair — whitelisted repair scripts, sudo-run via /usr/local/sbin/pluto-repair.
    // Body: { action: "worker-and-site"|"wildcard-ssl"|"deploy-and-verify"|"all", slug?, wildcard?, acmeEmail? }
    if (req.method === "POST" && (p === "/admin/repair" || p === "/sandbox/admin/repair")) {
      const body = await readJson(req).catch(() => ({}));
      const action = String(body?.action || "").trim();
      const allowed = new Set(["worker-and-site", "wildcard-ssl", "deploy-and-verify", "all"]);
      if (!allowed.has(action)) return json(res, 400, { error: "invalid_action", allowed: [...allowed] });
      const args = [action];
      const safeArg = (v) => typeof v === "string" && /^[A-Za-z0-9._@:/-]{0,253}$/.test(v);
      if (body?.slug && safeArg(String(body.slug))) args.push("--slug", String(body.slug));
      if (body?.wildcard && safeArg(String(body.wildcard))) args.push("--wildcard", String(body.wildcard));
      if (body?.acmeEmail && safeArg(String(body.acmeEmail))) args.push("--acme-email", String(body.acmeEmail));
      const startedAt = Date.now();
      const chunks = [];
      let exitCode = -1;
      await new Promise((resolve) => {
        const child = spawn("sudo", ["-n", "/usr/local/sbin/pluto-repair", ...args], { stdio: ["ignore", "pipe", "pipe"] });
        const cap = (b) => { if (chunks.reduce((n, c) => n + c.length, 0) < 65536) chunks.push(b); };
        child.stdout.on("data", cap);
        child.stderr.on("data", cap);
        child.on("close", (code) => { exitCode = code ?? -1; resolve(); });
        child.on("error", (err) => { chunks.push(Buffer.from(`spawn error: ${err.message}\n`)); exitCode = 127; resolve(); });
      });
      const tail = Buffer.concat(chunks).toString("utf8").slice(-4096);
      let hint = null;
      if (exitCode === 127) hint = "/usr/local/sbin/pluto-repair not installed or sudoers rule missing — run `sudo bash pluto-backend/deploy/full-deploy.sh`.";
      else if (exitCode !== 0) hint = "Repair script exited non-zero — inspect tail for the failing step.";
      return json(res, 200, { ok: exitCode === 0, action, exitCode, durationMs: Date.now() - startedAt, tail, hint });
    }

    return json(res, 404, { error: "not_found" });
  } catch (e) {
    return json(res, 500, { error: e?.message ?? String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sandbox-worker] listening on 127.0.0.1:${PORT}, sites root=${SITES_ROOT}, upstream=${UPSTREAM}`);
});
