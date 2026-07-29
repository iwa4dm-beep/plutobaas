import {
  getProfiles, saveProfile, setActiveProfile, deleteProfile,
  getHistory, DEFAULT_ENDPOINT, preflight,
} from "./lib.js";

const $ = (id) => document.getElementById(id);
const out = (v) => ($("out").textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2));
const msg = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));

/* ------------------------------- tabs -------------------------------- */
document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === "history") renderHistory();
  };
});

/* ----------------------------- settings ------------------------------ */
async function renderProfiles() {
  const { list, active } = await getProfiles();
  $("profileSelect").innerHTML = list.map((p) => `<option ${p.name === active.name ? "selected" : ""}>${p.name}</option>`).join("");
  $("profileName").value = active.name;
  $("endpoint").value = active.endpoint || DEFAULT_ENDPOINT;
  $("secret").value = active.secret || "";
  $("profileTag").textContent = `${active.name} · ${new URL(active.endpoint || DEFAULT_ENDPOINT).host}`;
  const { redact } = await chrome.storage.local.get("redact");
  $("redact").checked = redact !== false;
}

$("profileSelect").onchange = async (e) => { await setActiveProfile(e.target.value); renderProfiles(); };
$("save").onclick = async () => {
  await saveProfile({
    name: $("profileName").value.trim() || "default",
    endpoint: $("endpoint").value.trim(),
    secret: $("secret").value,
  });
  await chrome.storage.local.set({ redact: $("redact").checked });
  await renderProfiles();
  $("settingsOut").textContent = "Profile saved.";
};
$("del").onclick = async () => {
  await deleteProfile($("profileName").value.trim());
  await renderProfiles();
  $("settingsOut").textContent = "Profile deleted.";
};
$("test").onclick = async () => {
  $("settingsOut").textContent = "Testing…";
  const r = await msg({ type: "pluto:test" });
  $("settingsOut").textContent = r.ok
    ? `✓ Endpoint reachable and signature accepted (${r.ms} ms)\n${JSON.stringify(r.result, null, 2)}`
    : `✗ ${r.error}${r.status ? ` (HTTP ${r.status})` : ""}`;
};

/* ------------------------------ capture ------------------------------ */
function renderChecks(checks) {
  $("checks").innerHTML = checks
    .map((c) => `<li class="${c.ok ? "ok" : c.level === "error" ? "err" : c.level}">${c.ok ? "✓" : c.level === "error" ? "✗" : "•"} ${c.label}</li>`)
    .join("");
}

async function renderSecrets(payload) {
  const { findings } = await msg({ type: "pluto:scanSecrets", payload });
  $("secrets").innerHTML = findings?.length
    ? findings.map((f) => `<span class="chip err">${f.label} ×${f.count}</span>`).join("") +
      `<div class="muted">Redaction is ${$("redact").checked ? "on" : "OFF — credentials would be transmitted!"}</div>`
    : `<span class="ok">No credentials found in payload.</span>`;
}

function setPayload(p) {
  $("payload").value = JSON.stringify(p, null, 2);
  renderSecrets(p);
}

$("scan").onclick = async () => {
  out("Scanning open tabs…");
  const r = await msg({ type: "pluto:scan" });
  if (!r?.merged) { out(r?.error || "Scan failed."); return; }
  renderChecks(r.checks);
  setPayload({ event_id: `${Date.now()}-${crypto.randomUUID()}`, ...r.merged });
  out(`Merged ${r.tabs}/${r.scanned} matching tabs: ${(r.merged.sources || []).join(", ") || "none"}.`);
};

$("collect").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { type: "pluto:collect" }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      out(chrome.runtime.lastError?.message || res?.error || "Could not read this tab.");
      return;
    }
    const merged = { event_id: `${Date.now()}-${crypto.randomUUID()}`, ...res.data };
    renderChecks(preflight(merged));
    setPayload(merged);
    out("Collected. Review the payload, then Send.");
  });
};

$("payload").oninput = () => {
  try { renderSecrets(JSON.parse($("payload").value)); } catch { $("secrets").textContent = "Payload is not valid JSON."; }
};

$("copy").onclick = async () => {
  await navigator.clipboard.writeText($("payload").value);
  out("Payload copied to clipboard.");
};

$("send").onclick = async () => {
  let payload;
  try { payload = JSON.parse($("payload").value); } catch { out("Payload is not valid JSON."); return; }
  out("Sending…");
  const r = await msg({ type: "pluto:send", payload, redact: $("redact").checked });
  if (r?.ok) out(r.result);
  else out(r?.queued ? `Queued for retry: ${r.error}` : `Failed: ${r?.error}`);
  renderHistory();
};

/* ------------------------------ history ------------------------------ */
async function renderHistory() {
  const [history, q] = await Promise.all([getHistory(), msg({ type: "pluto:queue" })]);
  $("queueInfo").textContent = q?.queue?.length ? `${q.queue.length} job(s) waiting to retry.` : "Retry queue empty.";
  $("history").innerHTML = history.length
    ? history
        .map((h) => {
          const cls = h.status === "sent" ? "ok" : h.status === "failed" ? "err" : "warn";
          return `<li><span class="${cls}">${h.status}</span> · ${new Date(h.at).toLocaleString()}
            <div class="muted">${(h.sources || []).join(", ") || "—"}${h.repo ? ` · ${h.repo.replace("https://github.com/", "")}` : ""}${h.supabase_ref ? ` · ${h.supabase_ref}` : ""}${h.sql_chars ? ` · ${h.sql_chars} SQL chars` : ""}${h.redactions ? ` · ${h.redactions} redactions` : ""}</div>
            ${h.error ? `<div class="err">${h.error}</div>` : ""}
            ${h.job_id ? `<div class="muted">job ${h.job_id}</div>` : ""}</li>`;
        })
        .join("")
    : `<li class="muted">No jobs sent yet.</li>`;
}

$("refreshHistory").onclick = renderHistory;
$("drain").onclick = async () => { await msg({ type: "pluto:drain" }); renderHistory(); };

renderProfiles();
