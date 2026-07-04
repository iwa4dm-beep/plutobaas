// Phase 47 — SLO burn-rate math (pure, no DB dependencies).
export interface SloRow {
  id: string; slug: string; service: string; route_pattern: string;
  kind: "availability" | "latency";
  objective: number; threshold_ms: number | null; window_days: number;
}

export const BURN_WINDOWS: Array<{ label: string; minutes: number; alertBurn: number }> = [
  { label: "5m",  minutes: 5,    alertBurn: 14.4 },
  { label: "1h",  minutes: 60,   alertBurn: 6 },
  { label: "6h",  minutes: 360,  alertBurn: 3 },
  { label: "24h", minutes: 1440, alertBurn: 1 },
];

export function burnRate(ratio: number, objective: number): number {
  const budget = 1 - objective;
  if (budget <= 0) return ratio > 0 ? Number.POSITIVE_INFINITY : 0;
  return ratio / budget;
}
