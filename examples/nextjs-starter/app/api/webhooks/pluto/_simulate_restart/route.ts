import { NextResponse } from "next/server";
import { idempotencyStats, resetHotCache } from "@/lib/webhook-idempotency";

export const runtime = "nodejs";

/**
 * Dev/CI-only helper that clears the in-memory hot cache used by the
 * webhook idempotency layer. This lets the E2E suite prove that
 * duplicate rejection survives a "restart" without actually killing
 * the Node process — the durable file/Redis store is untouched, so a
 * second delivery of the same `event.id` must still be detected as a
 * duplicate on the very next request.
 *
 * Gated on non-production environments (`NODE_ENV !== "production"`)
 * or when `CI=1`. In production this route returns 404.
 */
function allowed() {
  return process.env.NODE_ENV !== "production" || process.env.CI === "1";
}

export async function POST() {
  if (!allowed()) return new NextResponse("not found", { status: 404 });
  const before = await idempotencyStats();
  resetHotCache();
  const after = await idempotencyStats();
  return NextResponse.json({ ok: true, before, after });
}

export async function GET() {
  if (!allowed()) return new NextResponse("not found", { status: 404 });
  return NextResponse.json(await idempotencyStats());
}
