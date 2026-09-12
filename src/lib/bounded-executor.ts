import { HTTPError } from "./error";
import { limits } from "./limits";

export class WorkloadLimitError extends HTTPError {
  constructor(name: string) {
    super(`${name} concurrency limit reached`, {
      status: 429,
      code: "WORKLOAD_LIMIT_REACHED",
    });
  }
}

export class BoundedExecutor {
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly name: string,
    private readonly maximum: number,
  ) {}

  tryAcquire() {
    if (this.active >= this.maximum) {
      throw new WorkloadLimitError(this.name);
    }

    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  /**
   * Wait for a slot instead of failing. For background work (the chapter
   * import worker) where a 429 would abandon a job the operator asked for;
   * request handlers use `tryAcquire`/`run` so saturation surfaces as 429.
   */
  async acquire() {
    if (this.active >= this.maximum) {
      // release() hands the slot over directly, so `active` already counts
      // this waiter by the time the promise resolves. Incrementing here too
      // would let a tryAcquire() that lands in between oversubscribe.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active--;
  }

  async run<T>(operation: () => Promise<T>) {
    const release = this.tryAcquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  get activeCount() {
    return this.active;
  }
}

/**
 * Process-wide ceilings for the two workloads that outlive a single request:
 * Chromium pages and Gemini calls. Both are shared by every route, so they
 * live here rather than in a feature module.
 */
export const browserExecutor = new BoundedExecutor(
  "Browser",
  limits.browserConcurrency,
);
export const aiExecutor = new BoundedExecutor("AI", limits.aiConcurrency);
