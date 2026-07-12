// Live log stream hook with WebSocket + auto-reconnect + interruption status.
// Falls back to local-only mode when no stream URL is configured or repeated failures occur.
import { useCallback, useEffect, useRef, useState } from "react";

export type StreamStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "interrupted"
  | "local";

export type StreamEvent = {
  t: number;
  level: "info" | "ok" | "error";
  msg: string;
  source: "local" | "ws";
};

type Options = {
  /** WebSocket URL. If empty/undefined the hook stays in "local" mode. */
  url?: string | null;
  /** Max reconnect attempts before flipping to "interrupted". */
  maxAttempts?: number;
};

/**
 * useLogStream — merges local events (appended via `append`) with events
 * received over WebSocket. Automatically reconnects with exponential backoff.
 * When the stream can't be recovered the status becomes "interrupted" so the
 * UI can surface it explicitly.
 */
export function useLogStream({ url, maxAttempts = 5 }: Options) {
  const [status, setStatus] = useState<StreamStatus>(url ? "idle" : "local");
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [attempt, setAttempt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const manualCloseRef = useRef(false);

  const append = useCallback((level: StreamEvent["level"], msg: string) => {
    setEvents((l) => [...l, { t: Date.now(), level, msg, source: "local" }]);
  }, []);

  const reset = useCallback(() => {
    setEvents([]);
    attemptRef.current = 0;
    setAttempt(0);
  }, []);

  const closeSocket = useCallback(() => {
    manualCloseRef.current = true;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* noop */ }
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!url) { setStatus("local"); return; }
    if (typeof WebSocket === "undefined") { setStatus("local"); return; }
    manualCloseRef.current = false;
    setStatus(attemptRef.current === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch {
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      setAttempt(0);
      setStatus("connected");
    };
    ws.onmessage = (ev) => {
      try {
        const parsed = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
        const level: StreamEvent["level"] = parsed?.level === "error" || parsed?.level === "ok" ? parsed.level : "info";
        const msg = typeof parsed?.msg === "string" ? parsed.msg : String(ev.data);
        setEvents((l) => [...l, { t: Date.now(), level, msg, source: "ws" }]);
      } catch {
        setEvents((l) => [...l, { t: Date.now(), level: "info", msg: String(ev.data), source: "ws" }]);
      }
    };
    ws.onerror = () => { /* onclose will handle reconnect */ };
    ws.onclose = () => {
      wsRef.current = null;
      if (manualCloseRef.current) return;
      scheduleReconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const scheduleReconnect = useCallback(() => {
    attemptRef.current += 1;
    setAttempt(attemptRef.current);
    if (attemptRef.current > maxAttempts) {
      setStatus("interrupted");
      return;
    }
    setStatus("reconnecting");
    const delay = Math.min(15_000, 500 * 2 ** (attemptRef.current - 1));
    timerRef.current = setTimeout(() => { connect(); }, delay);
  }, [connect, maxAttempts]);

  const reconnectNow = useCallback(() => {
    if (!url) return;
    closeSocket();
    manualCloseRef.current = false;
    attemptRef.current = 0;
    setAttempt(0);
    connect();
  }, [url, closeSocket, connect]);

  useEffect(() => {
    if (!url) { setStatus("local"); return; }
    connect();
    return () => { closeSocket(); };
  }, [url, connect, closeSocket]);

  return { status, events, attempt, append, reset, reconnectNow };
}

export function statusLabel(s: StreamStatus, attempt: number): string {
  switch (s) {
    case "idle": return "idle";
    case "connecting": return "connecting…";
    case "connected": return "live (ws)";
    case "reconnecting": return `reconnecting… (try ${attempt})`;
    case "interrupted": return "stream interrupted — using local logs";
    case "local": return "local only (no stream configured)";
  }
}
