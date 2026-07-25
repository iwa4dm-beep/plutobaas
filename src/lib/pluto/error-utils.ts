/**
 * error-utils — user-facing error helpers for dashboard routes.
 *
 * Sits on top of `describeError` (in live.ts) and adds:
 *   - offline detection (navigator.onLine) with a distinct message
 *   - Zod validation formatting
 *   - `runSafe` HOF that wraps any async op with try/catch + optional toast,
 *     returning `{ ok, data, error }` so components stay declarative
 *   - `friendlyMessage(err)` returning a single-line human string ideal
 *     for inline validation and small UI slots
 *
 * Keep this module small and dependency-light — imported broadly.
 */
import { toast } from "sonner";
import { z } from "zod";
import { describeError } from "./live";

export type FriendlyError = {
  title: string;
  detail?: string;
  hint?: string;
  status?: number;
  /** True when we detected the browser is offline. */
  offline?: boolean;
};

const OFFLINE_MESSAGE: FriendlyError = {
  title: "You appear to be offline",
  detail: "Internet connection নেই মনে হচ্ছে — connection ঠিক হলে আবার try করুন।",
  hint: "Check your network and retry.",
  offline: true,
};

function isBrowserOffline(): boolean {
  if (typeof navigator === "undefined") return false;
  // navigator.onLine can be flaky, but is a reliable "false = offline" signal.
  return navigator.onLine === false;
}

/**
 * Turn any thrown value into a user-facing structured message.
 * Prefer over touching `describeError` directly — this layer adds
 * offline + validation handling.
 */
export function toFriendlyError(err: unknown): FriendlyError {
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    const path = first?.path?.length ? first.path.join(".") : "input";
    return {
      title: "Please check your input",
      detail: first ? `${path}: ${first.message}` : "Validation failed.",
      hint: err.issues.length > 1 ? `${err.issues.length - 1} more issue(s).` : undefined,
    };
  }
  if (isBrowserOffline()) return OFFLINE_MESSAGE;
  const info = describeError(err);
  return {
    title: info.title,
    detail: info.detail,
    hint: info.hint,
    status: info.status,
  };
}

/** Convenience: single-line message for inline UI (inputs, badges). */
export function friendlyMessage(err: unknown): string {
  const f = toFriendlyError(err);
  return f.detail ? `${f.title} — ${f.detail}` : f.title;
}

/**
 * runSafe — try/catch wrapper that:
 *   - logs the error to console with a stable tag
 *   - optionally shows a sonner toast (default: on)
 *   - returns a discriminated union so callers avoid throwing across UI
 *
 *   const res = await runSafe(() => projects.create(name), { tag: "projects.create" });
 *   if (!res.ok) return; // toast already shown
 *   setProjects((p) => [...p, res.data]);
 */
export async function runSafe<T>(
  fn: () => Promise<T>,
  opts: {
    tag?: string;
    toast?: boolean | "error-only";
    successMessage?: string;
    errorTitle?: string;
  } = {},
): Promise<{ ok: true; data: T } | { ok: false; error: FriendlyError; raw: unknown }> {
  const showToast = opts.toast ?? "error-only";
  try {
    const data = await fn();
    if (showToast === true && opts.successMessage) {
      toast.success(opts.successMessage);
    }
    return { ok: true, data };
  } catch (raw) {
    const error = toFriendlyError(raw);
    // eslint-disable-next-line no-console
    console.error(`[${opts.tag ?? "runSafe"}]`, raw);
    if (showToast !== false) {
      toast.error(opts.errorTitle ?? error.title, {
        description: error.detail ?? error.hint,
      });
    }
    return { ok: false, error, raw };
  }
}

/**
 * Assert-style validator that throws a ZodError. Pair with runSafe / try-catch
 * so the friendly layer picks it up automatically.
 */
export function validate<T>(schema: z.ZodType<T>, value: unknown, label = "input"): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // Prepend the label to the first issue's path for better UX.
    const enriched = new z.ZodError(
      parsed.error.issues.map((i) => ({ ...i, path: [label, ...i.path] })),
    );
    throw enriched;
  }
  return parsed.data;
}
