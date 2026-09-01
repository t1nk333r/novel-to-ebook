import { describe, expect, test } from "bun:test";
import { createLoadCoordinator } from "../ui/src/app/reader/lib/reader-load-coordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createLoadCoordinator", () => {
  test("starting a new generation invalidates the previous one", () => {
    const coordinator = createLoadCoordinator();
    const a = coordinator.start();
    expect(a.isCurrent()).toBe(true);

    const b = coordinator.start();
    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  test("starting a new generation aborts the previous generation's signal", () => {
    const coordinator = createLoadCoordinator();
    const a = coordinator.start();
    expect(a.signal.aborted).toBe(false);

    coordinator.start();
    expect(a.signal.aborted).toBe(true);
  });

  test("a slower A resolving after B starts must not be treated as current", async () => {
    // Simulates: A starts, B starts, A resolves after B -- only B may install a view.
    const coordinator = createLoadCoordinator();
    const aWork = deferred<string>();
    const bWork = deferred<string>();

    const a = coordinator.start();
    const runA = aWork.promise.then((value) => ({ value, installed: a.isCurrent() }));

    const b = coordinator.start();
    const runB = bWork.promise.then((value) => ({ value, installed: b.isCurrent() }));

    // The newer load (B) finishes first...
    bWork.resolve("book-b");
    const resultB = await runB;
    expect(resultB.installed).toBe(true);

    // ...then the slower, stale load (A) finally resolves.
    aWork.resolve("book-a");
    const resultA = await runA;
    expect(resultA.installed).toBe(false);
  });

  test("a slower A rejecting after B starts must not be treated as current", async () => {
    const coordinator = createLoadCoordinator();
    const aWork = deferred<string>();

    const a = coordinator.start();
    const runA = aWork.promise.catch(() => a.isCurrent());

    coordinator.start();
    aWork.reject(new Error("stale fetch failed"));

    expect(await runA).toBe(false);
  });

  test("dispose invalidates the active generation and aborts its signal", () => {
    const coordinator = createLoadCoordinator();
    const a = coordinator.start();

    coordinator.dispose();

    expect(a.isCurrent()).toBe(false);
    expect(a.signal.aborted).toBe(true);
  });

  test("dispose (unmount) leaves no generation current for later starts to collide with", () => {
    const coordinator = createLoadCoordinator();
    const a = coordinator.start();
    coordinator.dispose();

    const b = coordinator.start();
    expect(a.isCurrent()).toBe(false);
    expect(b.isCurrent()).toBe(true);
    expect(b.id).not.toBe(a.id);
  });
});
