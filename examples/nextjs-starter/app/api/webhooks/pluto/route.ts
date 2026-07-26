import crypto from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Pluto webhook receiver. Verifies HMAC-SHA256 of the raw body using
 * PLUTO_WEBHOOK_SECRET, then processes the event.
 *
 * Header format: `X-Pluto-Signature: sha256=<hex>`
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

  // eslint-disable-next-line no-console
  console.log("[pluto:webhook]", event?.type ?? "unknown", event?.id ?? "");
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST signed events here" });
}
