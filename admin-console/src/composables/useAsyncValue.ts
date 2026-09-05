import { ref, shallowRef, onScopeDispose, type Ref, type ShallowRef } from 'vue';

export type AsyncState = 'loading' | 'ready' | 'error' | 'timeout';

export interface AsyncValue<T> {
  data: ShallowRef<T | null>;
  state: Ref<AsyncState>;
  error: Ref<string | null>;
  /** Milliseconds the last successful load took. */
  elapsedMs: Ref<number | null>;
  reload: () => Promise<void>;
}

export interface AsyncValueOptions {
  /**
   * How long to wait before giving up and reporting a timeout. Deliberately
   * longer than the server's own probe budget, so a slow-but-answering backend
   * reports its own result rather than being cut off by the client.
   */
  timeoutMs?: number;
  /** Start loading immediately. */
  immediate?: boolean;
}

/**
 * One independently-loading value.
 *
 * Each caller gets its own request, its own abort controller, and its own
 * state, so a slow or failing load shows up in exactly one place on the page
 * instead of blocking everything rendered alongside it.
 */
export function useAsyncValue<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  options: AsyncValueOptions = {}
): AsyncValue<T> {
  const { timeoutMs = 15000, immediate = true } = options;

  const data = shallowRef<T | null>(null);
  const state = ref<AsyncState>('loading');
  const error = ref<string | null>(null);
  const elapsedMs = ref<number | null>(null);

  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function reload(): Promise<void> {
    if (disposed) {
      return;
    }

    // Supersede any in-flight request so a fast reload cannot be overwritten by
    // a slow earlier response landing afterwards.
    controller?.abort();
    clearTimer();

    const activeController = new AbortController();
    controller = activeController;

    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      activeController.abort();
    }, timeoutMs);

    state.value = 'loading';
    error.value = null;

    const startedAt = Date.now();

    try {
      const result = await loader(activeController.signal);
      if (activeController !== controller || disposed) {
        return;
      }
      data.value = result;
      elapsedMs.value = Date.now() - startedAt;
      state.value = 'ready';
    } catch (caught) {
      if (activeController !== controller || disposed) {
        return;
      }
      if (timedOut) {
        state.value = 'timeout';
        error.value = `No response after ${Math.round(timeoutMs / 1000)}s.`;
      } else {
        state.value = 'error';
        error.value = caught instanceof Error ? caught.message : 'Request failed.';
      }
    } finally {
      clearTimer();
    }
  }

  onScopeDispose(() => {
    disposed = true;
    controller?.abort();
    clearTimer();
  });

  if (immediate) {
    void reload();
  }

  return { data, state, error, elapsedMs, reload };
}
