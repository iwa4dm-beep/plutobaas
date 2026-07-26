import crypto from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Pluto webhook receiver. Verifies HMAC-SHA256 of the raw body using
 * PLUTO_WEBHOOK_SECRET, then processes the event.
 *
 * Header format: `X-Pluto-Signature: sha256=<hex>`
 *
 * Idempotency: duplicate deliveries (same `event.id`) are recognized and
 * short-circuited with `{ ok: true, duplicate: true }` so downstream side
 * effects only run once. The in-memory ring buffer holds the last N ids
 * per process — pair with a persistent store (DB/Redis) for multi-instance
 * deployments. Retention window prevents unbounded growth.
 */
const SEEN_LIMIT = 1000;
const SEEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
type SeenEntry = { at: number };
const seen: Map<string, SeenEntry> =
  (globalThis as any).__plutoWebhookSeen ?? new Map<string, SeenEntry>();
(globalThis as any).__plutoWebhookSeen = seen;

function markSeen(id: string): boolean {
  const now = Date.now();
  // sweep expired
  for (const [k, v] of seen) {
    if (now - v.at > SEEN_TTL_MS) seen.delete(k);
  }
  if (seen.has(id)) return false;
  seen.set(id, { at: now });
  while (seen.size > SEEN_LIMIT) {
    const oldest = seen.keys().next().value;
    if (!oldest) break;
    seen.delete(oldest);
  }
  return true;
}

export async function POST(req: Request) {
  const secret = process.env.PLUTO_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "webhook_secret_missing" }, { status: 500 });
  }

  const sigHeader = req.headers.get("x-pluto-signature") ?? "";
  const rawBody = await req.text();

  const provided = sigHeader.startsWith("sha256=") ? sigHeader.slice(7) : sigHeader;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let event: any = null;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const eventId: string | undefined = event?.id;
  if (eventId && !markSeen(eventId)) {
    // eslint-disable-next-line no-console
    console.log("[pluto:webhook] duplicate", event?.type ?? "unknown", eventId);
    return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
  }

  // eslint-disable-next-line no-console
  console.log("[pluto:webhook]", event?.type ?? "unknown", eventId ?? "");
  return NextResponse.json({ ok: true, duplicate: false });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST signed events here" });
}
