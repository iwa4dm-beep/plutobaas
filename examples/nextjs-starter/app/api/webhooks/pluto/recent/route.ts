import { NextResponse } from "next/server";
import { idempotencyStats, listRecent } from "@/lib/webhook-idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Debug endpoint: returns the last N webhook outcomes (accepted /
 * duplicate / rejected) plus current idempotency-store stats and the
 * configured TTL. Consumed by `/debug/webhooks`.
 *
 * Gated behind `NEXT_PUBLIC_ENABLE_WEBHOOK_DEBUG=1` (default OFF in prod)
 * so production installs don't leak the recent-events log by accident.
 */
export async function GET(req: Request) {
  const enabled =
    process.env.NEXT_PUBLIC_ENABLE_WEBHOOK_DEBUG === "1" ||
    process.env.NODE_ENV !== "production";
  if (!enabled) {
    return NextResponse.json({ error: "debug_disabled" }, { status: 404 });
  }
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "50")));
  const [stats, events] = await Promise.all([idempotencyStats(), Promise.resolve(listRecent(limit))]);
  return NextResponse.json({ ok: true, stats, events });
}
