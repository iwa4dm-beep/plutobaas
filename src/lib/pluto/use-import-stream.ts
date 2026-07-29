// Client hook: live import-job timeline over SSE (fetch + ReadableStream so we
// can send the Pluto bearer token, which EventSource cannot do).
//
// Falls back to a one-shot refresh callback if the stream cannot be opened, so
// the panel still works behind proxies that buffer text/event-stream.
import { useEffect, useRef, useState } from "react";
import type { ImportEventView } from "./import-job.functions";

const SESSION_KEY = "pluto.session.v1";

export type LiveJobPatch = {
  id: string;
  status: string;
  paused: boolean;
  paused_by: string | null;
  paused_at: string | null;
  resume_step: string | null;
  applied_at: string | null;
  applied_by: string | null;
  selection: string[] | null;
  updated_at: string;
};

function accessToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw).access_token ?? null) : null;
  } catch {
    return null;
  }
}

export type ImportStreamState = {
  connected: boolean;
  error: string | null;
};

/**
 * Subscribe to `/api/import-events/:jobId`. `onEvents` receives only newly
 * appended audit rows; `onJob` receives job-level changes (status, pause…).
 */
export function useImportEventStream(
  jobId: string | null,
  onEvents: (events: ImportEventView[]) => void,
  onJob: (patch: LiveJobPatch) => void,
): ImportStreamState {
  const [state, setState] = useState<ImportStreamState>({ connected: false, error: null });
  const evRef = useRef(onEvents);
  const jobRef = useRef(onJob);
  evRef.current = onEvents;
  jobRef.current = onJob;

  useEffect(() => {
    if (!jobId) {
      setState({ connected: false, error: null });
      return;
    }
    const ac = new AbortController();
    let cancelled = false;

    (async () => {
      const token = accessToken();
      try {
        const res = await fetch(`/api/import-events/${jobId}`, {
          headers: {
            Accept: "text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          setState({ connected: false, error: `stream ${res.status}` });
          return;
        }
        setState({ connected: true, error: null });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE frames are separated by a blank line.
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const evLine = frame.split("\n").find((l) => l.startsWith("event: "));
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!evLine || !dataLine) continue;
            const name = evLine.slice(7).trim();
            let payload: unknown;
            try { payload = JSON.parse(dataLine.slice(6)); } catch { continue; }
            if (name === "events") evRef.current(payload as ImportEventView[]);
            else if (name === "job") jobRef.current(payload as LiveJobPatch);
            else if (name === "error") setState({ connected: true, error: String((payload as { error?: string }).error ?? "stream error") });
          }
        }
      } catch (e) {
        if (!cancelled && (e as Error).name !== "AbortError") {
          setState({ connected: false, error: (e as Error).message });
        }
      } finally {
        if (!cancelled) setState((s) => ({ ...s, connected: false }));
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [jobId]);

  return state;
}
