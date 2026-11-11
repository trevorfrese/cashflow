'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ZodType } from 'zod';

import { ApiError, call } from './api';

export interface Loaded<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** True on the first load and on every reload. `data` stays in place while reloading. */
  loading: boolean;
  reload: () => void;
}

/**
 * Load one API resource through the proxy. Pass `null` as the path to hold off. The last
 * good data stays on screen while a reload is in flight, so the page does not jump.
 */
export function useApi<T>(path: string | null, schema: ZodType<T>): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({
    loading: path !== null,
  });
  const [tick, setTick] = useState(0);
  const schemaRef = useRef(schema);
  schemaRef.current = schema;

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    call(path, { schema: schemaRef.current, signal: controller.signal })
      .then((data) => setState({ data, loading: false }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const error =
          cause instanceof ApiError
            ? cause
            : new ApiError(0, 'UNKNOWN', cause instanceof Error ? cause.message : 'Unknown error');
        setState((s) => ({ data: s.data, error, loading: false }));
      });
    return () => controller.abort();
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

export interface Action<B> {
  run: (body: B) => Promise<boolean>;
  busy: boolean;
  error: ApiError | undefined;
  reset: () => void;
}

/**
 * A state-changing call. `run` resolves to true when the API accepted it; on a refusal the
 * error is kept for the form to show and `run` resolves to false.
 */
export function useAction<B, T>(
  path: string,
  schema: ZodType<T>,
  onDone?: (result: T) => void,
): Action<B> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const schemaRef = useRef(schema);
  schemaRef.current = schema;

  const run = useCallback(
    async (body: B) => {
      setBusy(true);
      setError(undefined);
      try {
        const result = await call(path, { method: 'POST', body, schema: schemaRef.current });
        doneRef.current?.(result);
        return true;
      } catch (cause) {
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError(0, 'UNKNOWN', cause instanceof Error ? cause.message : 'Unknown error'),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [path],
  );
  const reset = useCallback(() => setError(undefined), []);
  return { run, busy, error, reset };
}
