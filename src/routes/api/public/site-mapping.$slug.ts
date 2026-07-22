import { createFileRoute } from '@tanstack/react-router'

// Public read-only site-mapping resolver.
//   GET /api/public/site-mapping/<slug>
// Returns { slug, apex, apiUrl, prodUrl, previewUrl, workerBase } for the
// sandbox worker and CLI health checks. No secrets, no PII.
//
// Configurable via env: PUBLIC_APEX (default app.timescard.cloud) and
// PUBLIC_API_URL (default https://api.<apex>).

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60',
  }
}

export const Route = createFileRoute('/api/public/site-mapping/$slug')({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
      GET: async ({ params }) => {
        const slug = String(params.slug ?? '').toLowerCase()
        if (!SLUG_RE.test(slug)) {
          return new Response(
            JSON.stringify({ error: 'invalid_slug' }),
            { status: 400, headers: corsHeaders() },
          )
        }
        const apex = process.env.PUBLIC_APEX || 'app.timescard.cloud'
        const apiUrl = (process.env.PUBLIC_API_URL || `https://api.${apex.replace(/^app\./, '')}`).replace(/\/+$/, '')
        const body = {
          slug,
          apex,
          apiUrl,
          prodUrl: `https://${slug}.${apex}/`,
          previewUrl: `https://${slug}-dev.${apex}/`,
          workerBase: `${apiUrl}/sites/${slug}/`,
          siteStatus: `${apiUrl}/site-status/${slug}`,
          ts: new Date().toISOString(),
        }
        return new Response(JSON.stringify(body), { status: 200, headers: corsHeaders() })
      },
    },
  },
})
