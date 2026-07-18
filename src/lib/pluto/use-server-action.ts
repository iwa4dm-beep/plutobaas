/**
 * useServerAction — thin wrapper around a server-fn (or any async fn) that
 * standardizes: loading state, structured error state, and a friendly toast.
 *
 *   const rotate = useServerAction(rotateSlugSecret, {
 *     successMessage: "Secret rotated",
 *     onSuccess: () => queryClient.invalidateQueries(...),
 *   });
 *   <Button disabled={rotate.isPending} onClick={() => rotate.run({ data: { slug } })} />
 *   <ErrorBanner error={rotate.error} onRetry={rotate.reset} />
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { describeError } from "./live";

export type ServerActionState<TResult> = {
  isPending: boolean;
  error: unknown;
  data: TResult | undefined;
  run: (...args: unknown[]) => Promise<TResult | undefined>;
  reset: () => void;
};

export function useServerAction<TFn extends (...args: never[]) => Promise<unknown>>(
  fn: TFn,
  opts: {
    successMessage?: string;
    errorTitle?: string;
    silent?: boolean;
    onSuccess?: (result: Awaited<ReturnType<TFn>>) => void;
    onError?: (err: unknown) => void;
  } = {},
): ServerActionState<Awaited<ReturnType<TFn>>> {
  type TResult = Awaited<ReturnType<TFn>>;
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [data, setData] = useState<TResult | undefined>(undefined);
  // Track the latest call so a stale slow response can't overwrite a newer one.
  const callIdRef = useRef(0);

  const run = useCallback(
    async (...args: unknown[]): Promise<TResult | undefined> => {
      const myId = ++callIdRef.current;
      setIsPending(true);
      setError(null);
      try {
        const result = (await (fn as unknown as (...a: unknown[]) => Promise<unknown>)(...args)) as TResult;
        if (myId !== callIdRef.current) return undefined;
        setData(result);
        if (opts.successMessage) toast.success(opts.successMessage);
        opts.onSuccess?.(result);
        return result;
      } catch (err) {
        if (myId !== callIdRef.current) return undefined;
        setError(err);
        if (!opts.silent) {
          const info = describeError(err);
          toast.error(opts.errorTitle ?? info.title, {
            description: info.detail ?? info.hint,
          });
        }
        opts.onError?.(err);
        // Don't rethrow — component reads state.error instead.
        return undefined;
      } finally {
        if (myId === callIdRef.current) setIsPending(false);
      }
    },
    // fn/opts intentionally captured by ref-like usage — callers pass stable fns
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const reset = useCallback(() => {
    callIdRef.current++;
    setError(null);
    setData(undefined);
    setIsPending(false);
  }, []);

  return { isPending, error, data, run, reset };
}
