/**
 * Tracks the "current" load generation for the reader so a slower,
 * superseded book load can never win a race against a newer one and mutate
 * state that belongs to the current book (e.g. a stale `bookKey`'s fetch
 * resolving after the user has already navigated to a different book).
 *
 * Only the generation returned by the most recently started `start()` call
 * is ever current; calling `start()` again (or `dispose()`) invalidates
 * every prior generation and aborts its associated `AbortSignal`.
 *
 * This coordinator only ever *discards* stale generations -- it never closes
 * or races shared resources (e.g. the Foliate view) on a caller's behalf.
 * Callers must check `isCurrent()` before mutating shared state, and must
 * wait for their own async work (e.g. `view.open()`) to fully settle before
 * closing/removing anything, since closing a Foliate view while its own
 * `open()` call is still in flight is not assumed to be safe.
 */
export interface LoadGeneration {
  /** Monotonically increasing id, unique per generation. */
  readonly id: number;
  /** Aborted once this generation is superseded or the coordinator is disposed. */
  readonly signal: AbortSignal;
  /** True only while this is the most recently started, non-disposed generation. */
  isCurrent(): boolean;
}

export interface LoadCoordinator {
  /** Starts (and returns) a new generation, invalidating and aborting any previous one. */
  start(): LoadGeneration;
  /** Invalidates and aborts the active generation without starting a new one. */
  dispose(): void;
}

export function createLoadCoordinator(): LoadCoordinator {
  let generation = 0;
  let controller: AbortController | null = null;

  const invalidate = () => {
    controller?.abort();
    controller = null;
    generation += 1;
  };

  const start = (): LoadGeneration => {
    invalidate();
    const id = generation;
    controller = new AbortController();
    const { signal } = controller;

    return {
      id,
      signal,
      isCurrent: () => id === generation,
    };
  };

  const dispose = () => {
    invalidate();
  };

  return { start, dispose };
}
