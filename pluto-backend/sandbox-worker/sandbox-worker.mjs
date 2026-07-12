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

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.SANDBOX_SHARED_SECRET ?? "";
const SITES_ROOT = process.env.SITES_ROOT ?? "/var/lib/pluto/sites";
const UPSTREAM = (process.env.PLUTO_UPSTREAM_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
const SERVICE_KEY = process.env.PLUTO_SERVICE_ROLE_KEY ?? "";

if (!SECRET) { console.error("SANDBOX_SHARED_SECRET is required"); process.exit(1); }
if (!SERVICE_KEY) { console.error("PLUTO_SERVICE_ROLE_KEY is required"); process.exit(1); }

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

async function unpack({ workspaceId, bucket, key }) {
  const ws = safeSlug(workspaceId);
  if (!ws) throw new Error("invalid workspaceId");
  if (!bucket || !key) throw new Error("bucket and key are required");

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

  // Atomic symlink flip: current -> releaseDir (relative)
  const currentLink = path.join(wsRoot, "current");
  const tmpLink = path.join(wsRoot, `.current-${randomUUID().slice(0, 6)}`);
  await fsp.symlink(path.relative(wsRoot, webRoot), tmpLink);
  await fsp.rename(tmpLink, currentLink);

  // Write manifest
  const manifest = {
    workspaceId: ws,
    bucket,
    key,
    releaseDir,
    webRoot,
    servedAt: new Date().toISOString(),
    sizeBytes: zipBytes.length,
    durationMs: Date.now() - started,
  };
  await fsp.writeFile(path.join(wsRoot, "current.json"), JSON.stringify(manifest, null, 2));

  // Prune old releases (keep 5 most recent)
  const releases = (await fsp.readdir(wsRoot, { withFileTypes: true }))
    .filter(d => d.isDirectory() && d.name.startsWith("release-"))
    .map(d => d.name).sort().reverse();
  for (const old of releases.slice(5)) {
    await fsp.rm(path.join(wsRoot, old), { recursive: true, force: true }).catch(() => {});
  }

  return manifest;
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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      return json(res, 200, { ok: true, service: "pluto-sandbox-worker", uptime: process.uptime() });
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
    return json(res, 404, { error: "not_found" });
  } catch (e) {
    return json(res, 500, { error: e?.message ?? String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sandbox-worker] listening on 127.0.0.1:${PORT}, sites root=${SITES_ROOT}, upstream=${UPSTREAM}`);
});
