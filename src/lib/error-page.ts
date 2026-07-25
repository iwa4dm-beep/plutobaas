/**
 * SSR fallback page for catastrophic 500s.
 *
 * MUST stay dependency-free — this is the last line of defence when the
 * app's module graph fails to init. `renderErrorPage` accepts an optional
 * `traceId` so operators can grep server logs for the exact request.
 */
export function renderErrorPage(opts: { traceId?: string; supportEmail?: string } = {}): string {
  const traceId = (opts.traceId ?? "").replace(/[^a-zA-Z0-9_\-.:]/g, "").slice(0, 128);
  const supportEmail = opts.supportEmail ?? "support@timescard.cloud";
  const subject = encodeURIComponent(`Error report${traceId ? ` — trace ${traceId}` : ""}`);
  const supportHref = `mailto:${supportEmail}?subject=${subject}`;
  const traceBlock = traceId
    ? `<p class="trace">Trace ID: <code id="trace">${traceId}</code>
         <button type="button" class="copy" onclick="navigator.clipboard&&navigator.clipboard.writeText('${traceId}');this.textContent='Copied'">Copy</button>
       </p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>This page didn't load</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font: 15px/1.5 system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 30rem; width: 100%; text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: #4b5563; margin: 0 0 1rem; }
      .trace { font-size: 12px; color: #6b7280; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f4f6; padding: 1px 5px; border-radius: 3px; }
      .actions { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; margin-top: 1.25rem; }
      a, button { padding: 0.5rem 1rem; border-radius: 0.375rem; font: inherit; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
      .primary { background: #111; color: #fff; }
      .secondary { background: #fff; color: #111; border-color: #d1d5db; }
      .copy { padding: 1px 8px; font-size: 11px; margin-left: 4px; background: #fff; border: 1px solid #d1d5db; border-radius: 3px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>This page didn't load</h1>
      <p>Something went wrong on our end. You can try refreshing, head back home, or contact support.</p>
      ${traceBlock}
      <div class="actions">
        <button class="primary" onclick="location.reload()">Try again</button>
        <a class="secondary" href="/">Go home</a>
        <a class="secondary" href="${supportHref}">Contact support</a>
      </div>
    </div>
  </body>
</html>`;
}
