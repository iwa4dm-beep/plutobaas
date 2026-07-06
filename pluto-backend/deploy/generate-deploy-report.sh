#!/usr/bin/env bash
# Post-deploy report generator — runs the migrator in JSON mode and produces
# a self-contained HTML report showing applied vs missing migrations,
# per-file timings, and any runner errors.
#
#   deploy/generate-deploy-report.sh              → writes deploy/reports/deploy-<ts>.html
#   OUT=/tmp/foo.html deploy/generate-deploy-report.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/docker/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="$ROOT/deploy/reports"
OUT="${OUT:-$OUT_DIR/deploy-$TS.html}"
JSON_OUT="$OUT_DIR/deploy-$TS.json"
mkdir -p "$OUT_DIR"

echo "▶ running migrator (JSON mode) → $JSON_OUT"
# Reuse the api image so npm deps (postgres.js) are already present.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
  run --rm --no-deps \
  -e PLUTO_MIGRATION_REPORT=/tmp/report.json \
  --entrypoint sh api -c \
  'node /app/packages/api/scripts/migrate.mjs && cat /tmp/report.json' \
  > "$JSON_OUT" || true

# The last valid JSON object in the stream is our report.
python3 - "$JSON_OUT" "$OUT" <<'PY'
import json, sys, html, pathlib, re
src, out = sys.argv[1], sys.argv[2]
raw = pathlib.Path(src).read_text(errors='replace')
# Extract the last {...} JSON blob (migrator may have printed log lines too).
m = list(re.finditer(r'\{[\s\S]*?"summary"\s*:\s*\{[\s\S]*?\}\s*\}', raw))
report = json.loads(m[-1].group(0)) if m else {"error": "no JSON report captured", "raw": raw[-4000:]}

def esc(x): return html.escape(str(x))
rows_applied = ''.join(
  f'<tr><td>{esc(r["file"])}</td><td>{esc(r["duration_ms"])} ms</td><td class="ok">✔</td><td></td></tr>'
  for r in report.get('results', []) if r.get('ok')
)
rows_failed = ''.join(
  f'<tr><td>{esc(r["file"])}</td><td>{esc(r.get("duration_ms",0))} ms</td><td class="err">✘</td>'
  f'<td><code>{esc(r.get("code") or "")}</code> {esc(r.get("error",""))}</td></tr>'
  for r in report.get('results', []) if not r.get('ok')
)
pending_left = [p for p in report.get('pending', [])
                if not any(r['file']==p for r in report.get('results', []))]
rows_missing = ''.join(f'<tr><td>{esc(p)}</td><td>—</td><td class="warn">⏳ not applied</td><td></td></tr>' for p in pending_left)
applied_before = ''.join(f'<li><code>{esc(r["name"])}</code> <span class=muted>@ {esc(r["applied_at"])}</span></li>' for r in report.get('applied_before', []))

summary = report.get('summary', {})
html_doc = f"""<!doctype html><html><head><meta charset=utf-8>
<title>Pluto deploy report — {esc(report.get('started_at','?'))}</title>
<style>
 body{{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:2rem auto;max-width:960px;color:#111}}
 h1{{margin:0 0 .25rem}} .muted{{color:#666}}
 table{{border-collapse:collapse;width:100%;margin:.75rem 0 1.5rem}}
 th,td{{padding:.4rem .6rem;border-bottom:1px solid #eee;text-align:left;vertical-align:top}}
 th{{background:#f7f7f8}} code{{background:#f2f2f4;padding:1px 4px;border-radius:3px}}
 .ok{{color:#0a7f2e}} .err{{color:#b91c1c}} .warn{{color:#a16207}}
 .grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem;margin:1rem 0}}
 .card{{padding:.75rem;border:1px solid #e5e5e7;border-radius:6px}}
 .card b{{display:block;font-size:1.4rem}}
</style></head><body>
<h1>Pluto deploy report</h1>
<div class=muted>DB: <code>{esc(report.get('database','?'))}</code> · started {esc(report.get('started_at','?'))} → finished {esc(report.get('finished_at','?'))} · dry_run={esc(report.get('dry_run',False))}</div>
<div class=grid>
 <div class=card><span class=muted>pending</span><b>{esc(summary.get('total_pending',0))}</b></div>
 <div class=card><span class=muted>applied</span><b class=ok>{esc(summary.get('applied',0))}</b></div>
 <div class=card><span class=muted>failed</span><b class=err>{esc(summary.get('failed',0))}</b></div>
 <div class=card><span class=muted>skipped</span><b class=warn>{esc(summary.get('skipped',0))}</b></div>
</div>
<h2>This run</h2>
<table><thead><tr><th>Migration</th><th>Duration</th><th>Status</th><th>Error</th></tr></thead>
<tbody>{rows_applied or ''}{rows_failed or ''}{rows_missing or ''}
{'<tr><td colspan=4 class=muted>No migrations processed.</td></tr>' if not (rows_applied or rows_failed or rows_missing) else ''}
</tbody></table>
<h2>Ledger (already applied before this run)</h2>
<ul>{applied_before or '<li class=muted>none</li>'}</ul>
</body></html>"""
pathlib.Path(out).write_text(html_doc)
print(f"✔ wrote {out}")
PY

echo "✔ HTML report: $OUT"
echo "  raw JSON:    $JSON_OUT"
