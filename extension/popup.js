const $ = (id) => document.getElementById(id);
const out = (v) => ($("out").textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2));

chrome.storage.local.get(["endpoint", "secret"]).then(({ endpoint, secret }) => {
  $("endpoint").value = endpoint || "https://plutobaas.lovable.app/api/public/pluto-import";
  $("secret").value = secret || "";
});

$("save").onclick = async () => {
  await chrome.storage.local.set({ endpoint: $("endpoint").value.trim(), secret: $("secret").value });
  out("Settings saved.");
};

$("collect").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { type: "pluto:collect" }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      out(chrome.runtime.lastError?.message || res?.error || "Could not read this tab.");
      return;
    }
    const merged = { event_id: `${Date.now()}-${crypto.randomUUID()}`, ...res.data };
    $("payload").value = JSON.stringify(merged, null, 2);
    out("Collected. Review the payload, then Send.");
  });
};

$("send").onclick = () => {
  let payload;
  try {
    payload = JSON.parse($("payload").value);
  } catch (e) {
    out("Payload is not valid JSON.");
    return;
  }
  out("Sending…");
  chrome.runtime.sendMessage({ type: "pluto:send", payload }, (res) => {
    out(res?.ok ? res.result : `Failed: ${res?.error}`);
  });
};
