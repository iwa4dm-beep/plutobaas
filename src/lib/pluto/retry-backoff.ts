/**
 * Exponential-backoff retry helper for domain verify / health operations.
 *
 * Delays follow: 1s, 2s, 4s, 8s, 16s (capped at maxDelayMs), with ±25% jitter.
 * The caller passes an AbortSignal to cancel between attempts, and an
 * `onAttempt` callback so the UI can render live status.
 */
export type RetryAttempt = {
  attempt: number;      // 1-indexed
  maxAttempts: number;
  waitingMs: number;    // 0 while the operation is running
  lastError?: unknown;
};

export type RetryOptions = {
  maxAttempts?: number;   // default 5
  baseDelayMs?: number;   // default 1000
  maxDelayMs?: number;    // default 16000
  jitter?: number;        // 0..1, default 0.25
  signal?: AbortSignal;
  onAttempt?: (a: RetryAttempt) => void;
  /** Return false to stop retrying (e.g. permission errors). */
  shouldRetry?: (err: unknown) => boolean;
};

export async function retryWithBackoff<T>(
  op: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 16_000;
  const jitter = opts.jitter ?? 0.25;
  let lastErr: unknown;
  for (let i = 1; i <= maxAttempts; i++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    opts.onAttempt?.({ attempt: i, maxAttempts, waitingMs: 0, lastError: lastErr });
    try {
      return await op(i);
    } catch (err) {
      lastErr = err;
      if (opts.shouldRetry && !opts.shouldRetry(err)) throw err;
      if (i === maxAttempts) throw err;
      const raw = Math.min(cap, base * 2 ** (i - 1));
      const wait = Math.round(raw * (1 + (Math.random() * 2 - 1) * jitter));
      opts.onAttempt?.({ attempt: i, maxAttempts, waitingMs: wait, lastError: err });
      await sleep(wait, opts.signal);
    }
  }
  throw lastErr;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
