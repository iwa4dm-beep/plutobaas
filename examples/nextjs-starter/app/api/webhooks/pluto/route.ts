import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { claimEventId } from "@/lib/webhook-idempotency";

export const runtime = "nodejs";

/**
 * Pluto webhook receiver. Verifies HMAC-SHA256 of the raw body using
 * PLUTO_WEBHOOK_SECRET, then processes the event.
 *
 * Signature header: `X-Pluto-Signature: sha256=<hex>`.
 *
 * Idempotency: duplicate deliveries (same `event.id`) are recognized and
 * short-circuited with `{ ok: true, duplicate: true }` so downstream side
 * effects only run once. Dedupe keys live in a durable store (Redis when
 * PLUTO_WEBHOOK_REDIS_URL is set, otherwise a JSON file) so duplicates are
 * rejected even after the server process restarts.
 */
export async function POST(req: Request) {
  const secret = process.env.PLUTO_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "webhook_secret_missing" }, { status: 500 });
  }

  const sigHeader = req.headers.get("x-pluto-signature") ?? "";
  const rawBody = await req.text();

  const provided = sigHeader.startsWith("sha256=") ? sigHeader.slice(7) : sigHeader;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  let ok = false;
  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    ok = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  } catch {
    ok = false;
  }
  if (!ok) {
    // Reject BEFORE any side effect (including idempotency writes) so a
    // forged request can never poison the dedupe store.
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let event: any = null;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const eventId: string | undefined = event?.id;
  if (eventId) {
    const { fresh, backend } = await claimEventId(eventId);
    if (!fresh) {
      // eslint-disable-next-line no-console
      console.log("[pluto:webhook] duplicate", event?.type ?? "unknown", eventId, `(${backend})`);
      return NextResponse.json({ ok: true, duplicate: true, backend }, { status: 200 });
    }
    // eslint-disable-next-line no-console
    console.log("[pluto:webhook]", event?.type ?? "unknown", eventId, `(${backend})`);
    return NextResponse.json({ ok: true, duplicate: false, backend });
  }

  // eslint-disable-next-line no-console
  console.log("[pluto:webhook]", event?.type ?? "unknown", "(no id)");
  return NextResponse.json({ ok: true, duplicate: false });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST signed events here" });
}
