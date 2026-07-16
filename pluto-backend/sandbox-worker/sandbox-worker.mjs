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
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT ?? process.env.SANDBOX_WORKER_PORT ?? 8787);
const SECRET = process.env.SANDBOX_SHARED_SECRET ?? "";
const SITES_ROOT = process.env.SITES_ROOT ?? process.env.SANDBOX_SITES_ROOT ?? "/var/lib/pluto/sites";
const UPSTREAM = (process.env.PLUTO_UPSTREAM_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const SERVICE_KEY = process.env.PLUTO_SERVICE_ROLE_KEY ?? "";

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

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf-8") || "{}";
  return JSON.parse(text);
}

function safeSlug(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

async function fetchBundle(bucket, key) {
  if (!SERVICE_KEY) throw new Error("PLUTO_SERVICE_ROLE_KEY is required for POST /unpack");
  const url = `${UPSTREAM}/storage/v1/object/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } });
  if (!res.ok) throw new Error(`storage GET HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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

async function unpack({ workspaceId, slug, bucket, key, env, channel }) {
  const ws = safeSlug(workspaceId);
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

  const zipBytes = await fetchBundle(bucket, key);
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
    if (!st.isSymbolicLink()) return { ok: false, error: "slug not linked" };
    const target = await fsp.readlink(slugPath);
    const wsDir = path.isAbsolute(target) ? target : path.join(SITES_ROOT, target);
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

async function serveStatic(res, wsDir, linkName, relPath) {
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
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": data.length,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    return res.end(data);
  } catch {
    // SPA fallback → index.html at the release root.
    try {
      const idx = await fsp.readFile(path.join(baseDir, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"], "content-length": idx.length, "cache-control": "no-cache" });
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
  return serveStatic(res, wsDir, linkName, m[2] || "");
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
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
        version: "v1-static-serve-2026-07-16",
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
    if (req.method === "GET" && req.url && req.url.startsWith("/sites/")) {
      return handleStatic(req, res, "/sites/", "current");
    }
    if (req.method === "GET" && req.url && req.url.startsWith("/preview/")) {
      return handleStatic(req, res, "/preview/", "preview");
    }
    if (!checkSecret(req)) return json(res, 401, { error: "invalid or missing x-sandbox-secret" });

    if (req.method === "POST" && req.url === "/unpack") {
      const body = await readJson(req);
      const m = await unpack(body);
      return json(res, 200, { ok: true, ...m });
    }
    const statusMatch = req.method === "GET" && req.url && req.url.startsWith("/status/");
    if (statusMatch) {
      const ws = decodeURIComponent(req.url.slice("/status/".length));
      return json(res, 200, await status(ws));
    }
    const resolveMatch = req.method === "GET" && req.url && req.url.startsWith("/resolve/");
    if (resolveMatch) {
      const s = decodeURIComponent(req.url.slice("/resolve/".length));
      return json(res, 200, await resolveSlug(s));
    }
    if (req.method === "POST" && req.url === "/env") {
      const body = await readJson(req);
      const r = await rotateEnv(body);
      return json(res, 200, r);
    }
    if (req.method === "POST" && req.url === "/publish") {
      const r = await publish(await readJson(req));
      return json(res, 200, r);
    }
    if (req.method === "POST" && req.url === "/unpublish") {
      const r = await unpublish(await readJson(req));
      return json(res, 200, r);
    }
    return json(res, 404, { error: "not_found" });
  } catch (e) {
    return json(res, 500, { error: e?.message ?? String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sandbox-worker] listening on 127.0.0.1:${PORT}, sites root=${SITES_ROOT}, upstream=${UPSTREAM}`);
});
