import { getRequestHeader } from "@tanstack/react-start/server";

export function readIncomingAuthHeader(): string | null {
  try {
    const h = getRequestHeader("authorization");
    return h ?? null;
  } catch {
    return null;
  }
}
