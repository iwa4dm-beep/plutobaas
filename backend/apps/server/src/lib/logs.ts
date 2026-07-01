import { db } from "../db/index.js";

export async function log(
  source: "auth" | "rest" | "storage" | "admin",
  level: "info" | "warn" | "error",
  message: string,
  userId: string | null = null,
): Promise<void> {
  try {
    await db.insertInto("api_logs").values({
      id: crypto.randomUUID(),
      ts: new Date(),
      source,
      level,
      message,
      user_id: userId,
    }).execute();
  } catch {
    // never let logging break a request
  }
}
