// Pluto Migrator — MV3 service worker.
//
// Responsibilities:
//  * HMAC-SHA256 sign every payload and POST it to the Pluto ingest endpoint
//  * multi-tab scan (Lovable + GitHub + Supabase merged into one job)
//  * retry queue with exponential backoff for offline / 5xx failures
//  * job history, badge + desktop notifications
//  * context menu and Alt+Shift+P quick capture

import {
  hmacHex, getProfiles, scanSecrets, mergeDescriptors, preflight,
  pushHistory, updateHistory, statusEndpoint, planChunks, sqlLens,
  computeDelta, getWatchers, addWatcher, setWatchers, removeWatcher,
  getSettings, saveSettings,
} from "./lib.js";

const QUEUE_ALARM = "pluto-retry";
const WATCH_ALARM = "pluto-watch";
const AUTO_ALARM = "pluto-autocapture";
const MAX_ATTEMPTS = 6;


/* ---------------------------- transport ---------------------------- */

async function postSigned(payload) {
  const { active } = await getProfiles();
  if (!active?.endpoint || !active?.secret) {
    throw new Error("Set the Pluto endpoint and secret in the popup first.");
  }
  const body = JSON.stringify({
    ...payload,
    event_id: payload.event_id || `${Date.now()}-${crypto.randomUUID()}`,
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = await hmacHex(active.secret, `${ts}.${body}`);

  const res = await fetch(active.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pluto-timestamp": ts,
      "x-pluto-signature": `sha256=${signature}`,
    },
    body,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok && res.status !== 202) {
    const err = new Error(`HTTP ${res.status}: ${parsed.error || text.slice(0, 200)}`);
    err.status = res.status;
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }
  return parsed;
}

/** Signed POST to the control channel (status / rollback / upload state). */
async function postControl(body) {
  const { active } = await getProfiles();
  if (!active?.endpoint || !active?.secret) throw new Error("Configure endpoint + secret first.");
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = await hmacHex(active.secret, `${ts}.${raw}`);
  const res = await fetch(statusEndpoint(active.endpoint), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pluto-timestamp": ts,
      "x-pluto-signature": `sha256=${signature}`,
    },
    body: raw,
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${parsed.error || text.slice(0, 160)}`);
    err.status = res.status;
    err.retryable = res.status >= 500 || res.status === 429;
    throw err;
  }
  return parsed;
}

/* ------------------- resumable chunked upload ----------------------- */

async function uploadState(uploadId) {
  try {
    const r = await postControl({ action: "upload_status", upload_id: uploadId });
    return r?.state ?? null;
  } catch { return null; }
}

/**
 * Ship a big dump as ordered chunks. Already-received indices are skipped, so
 * an interrupted upload resumes exactly where it stopped.
 */
async function sendChunked(payload, chunks, onProgress) {
  const eventId = payload.event_id;
  const uploadId = payload.upload_id || `up_${eventId}`;
  payload.upload_id = uploadId;

  const envelope = { ...payload };
  delete envelope.supabase;
  envelope.supabase = { ...(payload.supabase || {}) };
  delete envelope.supabase.schema_sql;

  const remote = await uploadState(uploadId);
  const done = new Set(remote?.received ?? []);
  let last = null;

  for (let i = 0; i < chunks.length; i++) {
    if (done.has(i)) { onProgress?.({ index: i, total: chunks.length, skipped: true }); continue; }
    last = await postSigned({
      event_id: eventId,
      chunk: { upload_id: uploadId, index: i, total: chunks.length, data: chunks[i] },
      envelope: i === 0 ? envelope : undefined,
    });
    await chrome.storage.local.set({
      resumable: { upload_id: uploadId, event_id: eventId, index: i, total: chunks.length, at: Date.now() },
    });
    onProgress?.({ index: i, total: chunks.length });
  }
  await chrome.storage.local.remove("resumable");
  return last ?? (await uploadState(uploadId));
}



function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.png",
      title,
      message: String(message).slice(0, 300),
    });
  } catch { /* notifications optional */ }
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* ignore */ }
}

/* ------------------------- send + retry queue ----------------------- */

async function getQueue() {
  const { queue } = await chrome.storage.local.get("queue");
  return Array.isArray(queue) ? queue : [];
}
async function setQueue(queue) {
  await chrome.storage.local.set({ queue });
  await setBadge(queue.length ? String(queue.length) : "", "#f59e0b");
  if (queue.length) chrome.alarms.create(QUEUE_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  else chrome.alarms.clear(QUEUE_ALARM);
}

export async function send(payload, { redact = true } = {}) {
  const { findings, redacted } = scanSecrets(payload);
  const finalPayload = redact ? redacted : payload;
  const eventId = finalPayload.event_id || `${Date.now()}-${crypto.randomUUID()}`;
  finalPayload.event_id = eventId;

  const sql = finalPayload.supabase?.schema_sql || "";
  const lens = sqlLens(sql);
  const { result: delta, commit: commitDelta } = await computeDelta(finalPayload);
  const settings = await getSettings();
  const chunks = planChunks(sql, Math.max(64, settings.chunkKb) * 1024);

  await pushHistory({
    event_id: eventId,
    at: new Date().toISOString(),
    status: "sending",
    sources: finalPayload.sources || [finalPayload.source].filter(Boolean),
    repo: finalPayload.repo,
    supabase_ref: finalPayload.supabase?.ref,
    sql_chars: sql.length,
    redactions: findings.length,
    chunks: chunks.length,
    lens: lens.stats,
    delta,
  });

  try {
    const result = chunks.length
      ? await sendChunked(finalPayload, chunks, (p) =>
          setBadge(`${Math.round(((p.index + 1) / p.total) * 100)}`, "#2563eb"))
      : await postSigned(finalPayload);
    const jobId = result?.job_id || result?.id || result?.state?.job_id || null;
    await updateHistory(eventId, { status: "sent", result, job_id: jobId });
    await commitDelta();
    if (jobId) await addWatcher(jobId, { event_id: eventId, repo: finalPayload.repo });
    chrome.alarms.create(WATCH_ALARM, { delayInMinutes: 0.2, periodInMinutes: Math.max(0.5, settings.watchIntervalMin) });
    await setBadge("✓", "#16a34a");
    setTimeout(() => setBadge(""), 4000);
    notify("Pluto Migrator", `Job accepted${jobId ? ` (${jobId})` : ""}${chunks.length ? ` — ${chunks.length} chunks` : ""}.`);
    return { ok: true, result, findings, lens, delta, chunks: chunks.length, job_id: jobId };
  } catch (e) {

    if (e.retryable || e.message?.includes("Failed to fetch")) {
      const queue = await getQueue();
      queue.push({ payload: finalPayload, attempts: 1, next_at: Date.now() + 60_000 });
      await setQueue(queue);
      await updateHistory(eventId, { status: "queued", error: e.message });
      notify("Pluto Migrator — queued", `${e.message}. Will retry automatically.`);
      return { ok: false, queued: true, error: e.message, findings };
    }
    await updateHistory(eventId, { status: "failed", error: e.message });
    await setBadge("!", "#dc2626");
    notify("Pluto Migrator — failed", e.message);
    return { ok: false, error: e.message, findings };
  }
}

async function drainQueue() {
  const queue = await getQueue();
  if (!queue.length) return;
  const remaining = [];
  for (const item of queue) {
    if (item.next_at > Date.now()) { remaining.push(item); continue; }
    try {
      const result = await postSigned(item.payload);
      await updateHistory(item.payload.event_id, { status: "sent", result });
      notify("Pluto Migrator", "Queued job delivered.");
    } catch (e) {
      const attempts = item.attempts + 1;
      if (attempts > MAX_ATTEMPTS) {
        await updateHistory(item.payload.event_id, { status: "failed", error: `giving up: ${e.message}` });
        notify("Pluto Migrator — gave up", e.message);
        continue;
      }
      remaining.push({ ...item, attempts, next_at: Date.now() + Math.min(2 ** attempts, 30) * 60_000 });
    }
  }
  await setQueue(remaining);
}

/* --------------- live job timeline + watchers ----------------------- */

/** Fetch job + timeline events (optionally only those newer than `since`). */
async function jobStatus({ job_id, event_id, since }) {
  return postControl({ action: "status", job_id, event_id, since });
}

/** One-click rollback tied to the same import job (pre-apply snapshot). */
async function rollbackJob({ job_id, dry_run = false }) {
  const r = await postControl({ action: "rollback", job_id, dry_run });
  notify(
    dry_run ? "Rollback dry-run" : "Rollback",
    r?.ok ? `OK — ${r.result?.statements ?? 0} statement(s).` : `Failed: ${r?.result?.error || r?.error}`,
  );
  return r;
}

/** Background poll: notify when a watched job changes status. */
async function pollWatchers() {
  const watchers = await getWatchers();
  if (!watchers.length) { chrome.alarms.clear(WATCH_ALARM); return; }
  const next = [];
  for (const w of watchers) {
    try {
      const r = await jobStatus({ job_id: w.job_id, since: w.since });
      const status = r?.job?.status;
      if (status && status !== w.last_status) {
        notify("Pluto Migrator", `Job ${w.job_id.slice(0, 8)} → ${status}`);
        if (["applied", "failed", "rolled_back", "verify_failed"].includes(status)) {
          await setBadge(status === "applied" ? "✓" : "!", status === "applied" ? "#16a34a" : "#dc2626");
        }
      }
      const lastEvent = r?.events?.[0]?.created_at || w.since;
      await chrome.storage.local.set({ [`timeline:${w.job_id}`]: r });
      const settled = ["applied", "failed", "rolled_back"].includes(status);
      if (!settled) next.push({ ...w, last_status: status ?? w.last_status, since: lastEvent });
      else next.push({ ...w, last_status: status, since: lastEvent, settled_at: Date.now() });
    } catch {
      next.push(w);
    }
  }
  await setWatchers(next);
}

/* ------------------------ scheduled auto-capture -------------------- */

async function rescheduleAuto() {
  const { autoCaptureMinutes } = await getSettings();
  chrome.alarms.clear(AUTO_ALARM);
  if (autoCaptureMinutes > 0) {
    chrome.alarms.create(AUTO_ALARM, { delayInMinutes: autoCaptureMinutes, periodInMinutes: autoCaptureMinutes });
  }
}

/* ------------------------ local bundle export ----------------------- */

/** Save the merged payload + raw SQL to disk before anything is uploaded. */
async function downloadBundle(payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sql = payload?.supabase?.schema_sql || "";
  const files = [
    { name: `pluto-import-${stamp}.json`, type: "application/json", body: JSON.stringify(payload, null, 2) },
  ];
  if (sql) files.push({ name: `pluto-schema-${stamp}.sql`, type: "text/plain", body: sql });
  for (const f of files) {
    const url = `data:${f.type};base64,${btoa(unescape(encodeURIComponent(f.body)))}`;
    await chrome.downloads.download({ url, filename: f.name, saveAs: false });
  }
  return { ok: true, files: files.map((f) => f.name) };
}



chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === QUEUE_ALARM) drainQueue();
  else if (a.name === WATCH_ALARM) pollWatchers();
  else if (a.name === AUTO_ALARM) quickCapture();
});

/* ---------------------------- tab scanning -------------------------- */

const SCAN_MATCH = ["https://lovable.dev/*", "https://supabase.com/*", "https://github.com/*"];

function askTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "pluto:collect" }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) return resolve(null);
      resolve(res.data);
    });
  });
}

async function scanAllTabs() {
  const tabs = await chrome.tabs.query({ url: SCAN_MATCH });
  const descriptors = [];
  for (const tab of tabs) {
    let d = await askTab(tab.id);
    if (!d) {
      // content script not injected yet (e.g. tab restored) — inject and retry
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["collector.js"] });
        d = await askTab(tab.id);
      } catch { /* restricted tab */ }
    }
    if (d) descriptors.push({ ...d, tab_title: tab.title, tab_url: tab.url });
  }
  const merged = mergeDescriptors(descriptors);
  return { merged, checks: preflight(merged), tabs: descriptors.length, scanned: tabs.length };
}

/* ------------------------- connection self-test --------------------- */

async function testConnection() {
  const { active } = await getProfiles();
  if (!active?.endpoint) return { ok: false, error: "No endpoint configured." };
  const started = Date.now();
  const probe = { event_id: `probe-${crypto.randomUUID()}`, ping: true, sources: ["probe"] };
  try {
    const result = await postSigned(probe);
    return { ok: true, ms: Date.now() - started, endpoint: active.endpoint, result };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, endpoint: active.endpoint, error: e.message, status: e.status };
  }
}

/* ------------------------------ messaging --------------------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    switch (msg?.type) {
      case "pluto:send":       return send(msg.payload, { redact: msg.redact !== false });
      case "pluto:scan":       return scanAllTabs();
      case "pluto:test":       return testConnection();
      case "pluto:scanSecrets":return scanSecrets(msg.payload);
      case "pluto:drain":      { await drainQueue(); return { ok: true, queue: (await getQueue()).length }; }
      case "pluto:queue":      return { queue: await getQueue() };
      case "pluto:status":     return jobStatus(msg);
      case "pluto:rollback":   return rollbackJob(msg);
      case "pluto:watchers":   return { watchers: await getWatchers() };
      case "pluto:watch":      return { watchers: await addWatcher(msg.job_id, { manual: true }) };
      case "pluto:unwatch":    { await removeWatcher(msg.job_id); return { watchers: await getWatchers() }; }
      case "pluto:pollNow":    { await pollWatchers(); return { ok: true }; }
      case "pluto:lens":       return sqlLens(msg.payload?.supabase?.schema_sql || "");
      case "pluto:bundle":     return downloadBundle(msg.payload);
      case "pluto:settings":   return { settings: await getSettings() };
      case "pluto:saveSettings": { const s = await saveSettings(msg.patch || {}); await rescheduleAuto(); return { settings: s }; }
      case "pluto:resumable":  return chrome.storage.local.get("resumable");
      case "pluto:resume":     { const r = await sendChunked(msg.payload, planChunks(msg.payload?.supabase?.schema_sql || "", (await getSettings()).chunkKb * 1024)); return { ok: true, result: r }; }
      default:                 return { ok: false, error: `unknown message ${msg?.type}` };
    }
  };
  run().then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

/* --------------------- quick capture (menu + hotkey) ---------------- */

async function quickCapture() {
  const { merged, checks } = await scanAllTabs();
  const blocking = checks.filter((c) => !c.ok && c.level === "error");
  if (blocking.length) {
    notify("Pluto Migrator — nothing to send", blocking.map((c) => c.label).join("; "));
    return;
  }
  await send(merged);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "pluto-quick-capture",
      title: "Pluto Migrator: scan tabs & send",
      contexts: ["page", "action"],
    });
  });
});

rescheduleAuto();

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "pluto-quick-capture") quickCapture();
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === "pluto-quick-capture") quickCapture();
});
