// Local delivery log for the webhook tester + replay engine.
//
// Every delivery (original send or replay) is stored under a short delivery id
// so a past payload can be resent later by id. Persisted in localStorage and
// observable via subscribe() so panels update in real time.

export type ReplayAttempt = {
  attempt: number;
  status: number | null;
  ok: boolean;
  durationMs: number;
  delayedMs: number;
  error?: string;
  responseBody?: string;
  at: string;
};

export type DeliveryStatus = "pending" | "delivering" | "succeeded" | "failed";

export type DeliveryRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  event: string;
  secret: string;
  /** Raw JSON body exactly as it was signed (without the `${ts}.` prefix). */
  body: string;
  timestamp: string;
  signature: string;
  signatureHeader: string;
  allowPrivateHost: boolean;
  status: DeliveryStatus;
  attempts: ReplayAttempt[];
  /** Delivery id this record was replayed from, if any. */
  replayOf?: string;
  replayCount: number;
};

const KEY = "pluto.webhook-deliveries.v1";
const MAX = 100;

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): DeliveryRecord[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as DeliveryRecord[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(rows: DeliveryRecord[]) {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(KEY, JSON.stringify(rows.slice(0, MAX)));
    } catch {
      /* quota — ignore */
    }
  }
  listeners.forEach((l) => l());
}

export function subscribeDeliveries(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function listDeliveries(): DeliveryRecord[] {
  return read();
}

export function getDelivery(id: string): DeliveryRecord | null {
  const needle = id.trim().toLowerCase();
  if (!needle) return null;
  return (
    read().find((d) => d.id.toLowerCase() === needle) ??
    read().find((d) => d.id.toLowerCase().startsWith(needle)) ??
    null
  );
}

export function newDeliveryId(): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(16).slice(2).padEnd(12, "0");
  return `dlv_${rnd.slice(0, 12)}`;
}

export function recordDelivery(
  rec: Omit<DeliveryRecord, "id" | "createdAt" | "updatedAt" | "replayCount"> &
    Partial<Pick<DeliveryRecord, "id" | "replayOf">>,
): DeliveryRecord {
  const now = new Date().toISOString();
  const row: DeliveryRecord = {
    replayCount: 0,
    ...rec,
    id: rec.id ?? newDeliveryId(),
    createdAt: now,
    updatedAt: now,
  };
  write([row, ...read().filter((d) => d.id !== row.id)]);
  return row;
}

export function updateDelivery(id: string, patch: Partial<DeliveryRecord>): DeliveryRecord | null {
  const rows = read();
  const idx = rows.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  const next = { ...rows[idx], ...patch, updatedAt: new Date().toISOString() };
  rows[idx] = next;
  write(rows);
  return next;
}

export function appendAttempt(id: string, attempt: ReplayAttempt): DeliveryRecord | null {
  const row = read().find((d) => d.id === id);
  if (!row) return null;
  return updateDelivery(id, { attempts: [...row.attempts, attempt] });
}

export function clearDeliveries() {
  write([]);
}

/** Exponential backoff with optional full jitter, capped. */
export function backoffFor(attempt: number, baseMs: number, jitter: boolean, capMs = 30_000): number {
  if (attempt <= 1) return 0;
  const raw = Math.min(baseMs * 2 ** (attempt - 2), capMs);
  return jitter ? Math.floor(Math.random() * raw) : raw;
}
