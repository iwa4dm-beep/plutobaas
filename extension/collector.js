// Pluto Migrator — content script.
// Scrapes the *page you are already logged into*; no credentials leave the
// browser. Returns a small descriptor to the popup on request.
function detect() {
  const host = location.hostname;
  const href = location.href;

  if (host.endsWith("lovable.dev")) {
    const m = href.match(/\/projects\/([0-9a-f-]{8,})/i);
    const ghLink = [...document.querySelectorAll('a[href*="github.com/"]')]
      .map((a) => a.getAttribute("href"))
      .find(Boolean);
    return {
      source: "lovable",
      lovable: {
        project_id: m ? m[1] : undefined,
        name: document.title.replace(/\s*[–|-]\s*Lovable.*$/i, "").trim(),
        url: href,
      },
      repo: ghLink || undefined,
    };
  }

  if (host.endsWith("supabase.com")) {
    const m = href.match(/\/project\/([a-z0-9]{10,})/i);
    // The SQL editor / schema page keeps the dump inside a CodeMirror or
    // textarea; grab whatever SQL is currently visible.
    const editor =
      document.querySelector(".cm-content")?.innerText ||
      document.querySelector("textarea")?.value ||
      "";
    return {
      source: "supabase",
      supabase: {
        ref: m ? m[1] : undefined,
        schema_sql: editor && /create\s+(table|policy|type|function)/i.test(editor) ? editor : undefined,
      },
    };
  }

  if (host === "github.com") {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)/);
    if (!m) return { source: "github" };
    const branch =
      document.querySelector("[data-hotkey='w'] span")?.textContent?.trim() || "main";
    return {
      source: "github",
      repo: `https://github.com/${m[1]}/${m[2]}`,
      ref: branch,
      zipball_url: `https://api.github.com/repos/${m[1]}/${m[2]}/zipball/${branch}`,
    };
  }

  return { source: "github" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "pluto:collect") {
    try {
      sendResponse({ ok: true, data: detect() });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  }
  return true;
});
