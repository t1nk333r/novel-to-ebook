import { describe, expect, test } from "bun:test";
import {
  BoundedExecutor,
  WorkloadLimitError,
} from "../src/lib/bounded-executor";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BoundedExecutor.run (request paths)", () => {
  test("rejects with a 429 once every slot is taken", async () => {
    const executor = new BoundedExecutor("Browser", 2);
    const first = deferred();
    const second = deferred();

    const a = executor.run(() => first.promise);
    const b = executor.run(() => second.promise);
    expect(executor.activeCount).toBe(2);

    let error: WorkloadLimitError | undefined;
    try {
      await executor.run(async () => "third");
    } catch (err) {
      if (err instanceof WorkloadLimitError) error = err;
    }

    expect(error).toBeDefined();
    expect(error?.status).toBe(429);
    expect(error?.code).toBe("WORKLOAD_LIMIT_REACHED");
    // The rejected caller must not have consumed a slot.
    expect(executor.activeCount).toBe(2);

    first.resolve();
    second.resolve();
    await Promise.all([a, b]);
    expect(executor.activeCount).toBe(0);
  });

  test("releases the slot when the operation throws", async () => {
    const executor = new BoundedExecutor("Browser", 1);

    await expect(
      executor.run(async () => {
        throw new Error("page crashed");
      }),
    ).rejects.toThrow("page crashed");

    expect(executor.activeCount).toBe(0);
    expect(await executor.run(async () => "reusable")).toBe("reusable");
  });
});

describe("BoundedExecutor.acquire (background work)", () => {
  test("waits for a slot instead of failing, and never oversubscribes", async () => {
    const executor = new BoundedExecutor("Browser", 1);

    const releaseFirst = await executor.acquire();
    let waiterRan = false;
    const waiting = executor.acquire().then((release) => {
      waiterRan = true;
      return release;
    });

    await Promise.resolve();
    expect(waiterRan).toBe(false);
    expect(executor.activeCount).toBe(1);

    releaseFirst();

    // The slot is handed straight to the waiter. A request path that lands in
    // this gap must still be rejected: if the slot were freed and re-counted,
    // this tryAcquire would succeed and two holders would run concurrently.
    expect(() => executor.tryAcquire()).toThrow(WorkloadLimitError);
    expect(executor.activeCount).toBe(1);

    const releaseSecond = await waiting;
    expect(waiterRan).toBe(true);
    expect(executor.activeCount).toBe(1);

    releaseSecond();
    expect(executor.activeCount).toBe(0);
  });

  test("hands slots to waiters in FIFO order", async () => {
    const executor = new BoundedExecutor("Browser", 1);
    const order: number[] = [];

    const release = await executor.acquire();
    const waiters = [1, 2, 3].map((n) =>
      executor.acquire().then((rel) => {
        order.push(n);
        return rel;
      }),
    );

    let current = release;
    for (let i = 0; i < waiters.length; i++) {
      current();
      current = await waiters[i]!;
    }
    current();

    expect(order).toEqual([1, 2, 3]);
    expect(executor.activeCount).toBe(0);
  });

  test("a release is idempotent and cannot free someone else's slot", async () => {
    const executor = new BoundedExecutor("Browser", 2);

    const release = await executor.acquire();
    await executor.acquire();
    expect(executor.activeCount).toBe(2);

    release();
    release();
    release();

    expect(executor.activeCount).toBe(1);
  });
});
