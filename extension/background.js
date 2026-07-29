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

  await pushHistory({
    event_id: eventId,
    at: new Date().toISOString(),
    status: "sending",
    sources: finalPayload.sources || [finalPayload.source].filter(Boolean),
    repo: finalPayload.repo,
    supabase_ref: finalPayload.supabase?.ref,
    sql_chars: finalPayload.supabase?.schema_sql?.length || 0,
    redactions: findings.length,
  });

  try {
    const result = await postSigned(finalPayload);
    await updateHistory(eventId, { status: "sent", result, job_id: result?.job_id || result?.id });
    await setBadge("✓", "#16a34a");
    setTimeout(() => setBadge(""), 4000);
    notify("Pluto Migrator", `Job accepted${result?.job_id ? ` (${result.job_id})` : ""}.`);
    return { ok: true, result, findings };
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

chrome.alarms.onAlarm.addListener((a) => { if (a.name === QUEUE_ALARM) drainQueue(); });

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

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "pluto-quick-capture") quickCapture();
});

chrome.commands?.onCommand.addListener((command) => {
  if (command === "pluto-quick-capture") quickCapture();
});
