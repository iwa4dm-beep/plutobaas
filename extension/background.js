// Pluto Migrator — MV3 service worker.
// Signs the payload with HMAC-SHA256 (WebCrypto) and POSTs it to the Pluto
// public ingest endpoint. The shared secret is stored in chrome.storage.local
// and is never sent over the wire — only the signature is.

async function hmacHex(secret, message) {
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

async function send(payload) {
  const { endpoint, secret } = await chrome.storage.local.get(["endpoint", "secret"]);
  if (!endpoint || !secret) throw new Error("Set the Pluto endpoint and secret in the popup first.");

  const body = JSON.stringify({
    ...payload,
    event_id: payload.event_id || `${Date.now()}-${crypto.randomUUID()}`,
  });
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = await hmacHex(secret, `${ts}.${body}`);

  const res = await fetch(endpoint, {
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
    throw new Error(`HTTP ${res.status}: ${parsed.error || text.slice(0, 200)}`);
  }
  return parsed;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "pluto:send") {
    send(msg.payload)
      .then((r) => sendResponse({ ok: true, result: r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
