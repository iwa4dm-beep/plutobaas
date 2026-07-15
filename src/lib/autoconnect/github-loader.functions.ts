// Server function: fetch a public/private GitHub repo as a ZIP tarball and
// return raw bytes to the browser. The client turns bytes into a File and
// feeds them to the existing `analyzeZip()` pipeline — no separate analyzer.
//
// Public repos: no token needed.
// Private repos: attach GITHUB_API_KEY (connector gateway) — the gateway
// forwards the request with a proper Bearer token.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z.object({
  // Accept either "owner/repo" or a full https://github.com/owner/repo[/…] URL.
  source: z.string().min(3).max(400),
  ref: z.string().max(120).optional(), // branch / tag / sha (default: repo default branch)
});

function parseSource(src: string): { owner: string; repo: string } {
  const s = src.trim();
  const m =
    s.match(/^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)/i) ??
    s.match(/^([^\/\s]+)\/([^\/\s#?]+)$/);
  if (!m) throw new Error("Invalid repo — use owner/repo or https://github.com/owner/repo");
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

const MAX_BYTES = 200 * 1024 * 1024; // 200 MB — same cap as ZIP upload flow

export const fetchGithubZip = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => InputSchema.parse(raw))
  .handler(async ({ data }) => {
    const { owner, repo } = parseSource(data.source);
    const ref = data.ref?.trim() || "HEAD";

    // Prefer the connector gateway if a GitHub connection is linked (private-repo
    // support + higher rate limits). Fall back to unauthenticated codeload for
    // public repos.
    const gatewayKey = process.env.GITHUB_API_KEY;
    const lovableKey = process.env.LOVABLE_API_KEY;

    const url = gatewayKey && lovableKey
      ? `https://connector-gateway.lovable.dev/github/repos/${owner}/${repo}/zipball/${encodeURIComponent(ref)}`
      : `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref === "HEAD" ? "refs/heads/main" : ref)}`;

    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (gatewayKey && lovableKey) {
      headers.Authorization = `Bearer ${lovableKey}`;
      headers["X-Connection-Api-Key"] = gatewayKey;
    }

    const res = await fetch(url, { headers, redirect: "follow" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Try `main` → `master` fallback for the anonymous codeload path.
      if (!gatewayKey && ref === "HEAD" && res.status === 404) {
        const alt = await fetch(`https://codeload.github.com/${owner}/${repo}/zip/refs/heads/master`);
        if (alt.ok) return await readCapped(alt, owner, repo);
      }
      throw new Error(`GitHub fetch failed [${res.status}]: ${body.slice(0, 400)}`);
    }
    return await readCapped(res, owner, repo);
  });

async function readCapped(res: Response, owner: string, repo: string) {
  const cl = Number(res.headers.get("content-length") ?? "0");
  if (cl && cl > MAX_BYTES) {
    throw new Error(`Repo tarball is ${Math.round(cl / 1024 / 1024)} MB — exceeds 200 MB cap`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`Repo tarball is ${Math.round(buf.byteLength / 1024 / 1024)} MB — exceeds 200 MB cap`);
  }
  // Base64-encode for JSON transport (server functions serialize response as JSON).
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.byteLength; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, Math.min(buf.byteLength, i + chunk)));
  }
  const b64 = btoa(bin);
  return {
    ok: true as const,
    owner,
    repo,
    bytes: buf.byteLength,
    filename: `${owner}-${repo}.zip`,
    zipBase64: b64,
  };
}
