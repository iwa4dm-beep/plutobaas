// Pluto Migrator — content script.
// Scrapes the *page you are already logged into*; no credentials leave the
// browser. Returns a descriptor to the popup / service worker on request.

const txt = (el) => (el?.textContent || "").trim();

function collectLovable(href) {
  const m = href.match(/\/projects\/([0-9a-f-]{8,})/i);
  const links = [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") || "");
  const ghLink = links.find((h) => /github\.com\/[^/]+\/[^/]+/.test(h));
  const supaLink = links.find((h) => /supabase\.(com|co)/.test(h));
  return {
    source: "lovable",
    lovable: {
      project_id: m ? m[1] : undefined,
      name: document.title.replace(/\s*[–|-]\s*Lovable.*$/i, "").trim(),
      url: href,
      published_url: links.find((h) => /\.lovable\.app/.test(h)) || undefined,
    },
    repo: ghLink || undefined,
    supabase_hint: supaLink || undefined,
  };
}

function collectSupabase(href) {
  const m = href.match(/\/project\/([a-z0-9]{10,})/i);
  // SQL editor / schema page keeps the dump inside CodeMirror, Monaco or a textarea.
  const editor =
    [...document.querySelectorAll(".cm-content, .monaco-editor .view-lines")]
      .map((n) => n.innerText)
      .sort((a, b) => b.length - a.length)[0] ||
    document.querySelector("textarea")?.value ||
    "";
  const sql = editor && /create\s+(table|policy|type|function|view)/i.test(editor) ? editor : undefined;

  // Table editor sidebar gives us the object inventory even without a dump.
  const tables = [...new Set(
    [...document.querySelectorAll('[role="menuitem"], [data-testid*="table"], nav a span')]
      .map(txt)
      .filter((t) => /^[a-z_][a-z0-9_]{1,60}$/.test(t)),
  )].slice(0, 300);

  return {
    source: "supabase",
    supabase: {
      ref: m ? m[1] : undefined,
      project_url: m ? `https://${m[1]}.supabase.co` : undefined,
      schema_sql: sql,
      sql_chars: sql ? sql.length : 0,
      tables: tables.length ? tables : undefined,
      page: location.pathname.split("/").pop(),
    },
  };
}

function collectGithub() {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)/);
  if (!m) return { source: "github" };
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, "");
  const branch =
    txt(document.querySelector("[data-hotkey='w'] span")) ||
    txt(document.querySelector("#branch-picker-repos-header-ref-selector span")) ||
    "main";
  const isPrivate = !!document.querySelector(".Label:not(.Label--success)")?.textContent?.match(/private/i);
  return {
    source: "github",
    repo: `https://github.com/${owner}/${repo}`,
    owner,
    repo_name: repo,
    ref: branch,
    private: isPrivate || undefined,
    zipball_url: `https://api.github.com/repos/${owner}/${repo}/zipball/${branch}`,
    default_branch_url: `https://github.com/${owner}/${repo}/tree/${branch}`,
  };
}

function detect() {
  const host = location.hostname;
  const href = location.href;
  if (host.endsWith("lovable.dev")) return collectLovable(href);
  if (host.endsWith("supabase.com")) return collectSupabase(href);
  if (host === "github.com") return collectGithub();
  return { source: "unknown", url: href };
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
