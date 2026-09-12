import { describe, expect, test } from "bun:test";
import { QueueManager } from "../src/lib/queue-mgr";

function deferred() {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  return { promise, resolve, reject };
}

describe("QueueManager dispatch", () => {
  test("a finished task is not re-run when the next one starts", async () => {
    const queue = new QueueManager();
    const calls: string[] = [];
    const secondDone = deferred();
    // Resolves early if the finished task is dispatched a second time, so this
    // test fails on the assertion instead of waiting out the test timeout.
    const firstReran = deferred();
    let firstRuns = 0;

    queue.add(async () => {
      calls.push("first");
      if (++firstRuns > 1) firstReran.resolve();
    });
    queue.add(async () => {
      calls.push("second");
      secondDone.resolve();
    });

    await Promise.race([secondDone.promise, firstReran.promise]);

    expect(calls).toEqual(["first", "second"]);
  }, 1000);

  test("every queued task runs exactly once, in order", async () => {
    const queue = new QueueManager();
    const calls: string[] = [];
    const thirdDone = deferred();

    for (const name of ["a", "b", "c"]) {
      queue.add(async () => {
        calls.push(name);
        if (name === "c") thirdDone.resolve();
      });
    }

    await thirdDone.promise;

    expect(calls).toEqual(["a", "b", "c"]);
  }, 1000);

  test("a task queued behind a running one starts as soon as it finishes", async () => {
    const queue = new QueueManager();
    const calls: string[] = [];
    const gate = deferred();
    const nextDone = deferred();

    queue.add(async () => {
      calls.push("slow");
      await gate.promise;
    });
    queue.add(async () => {
      calls.push("next");
      nextDone.resolve();
    });

    expect(calls).toEqual(["slow"]);

    gate.resolve();
    await nextDone.promise;

    expect(calls).toEqual(["slow", "next"]);
  }, 1000);

  test("getTasks filters by namespace", async () => {
    const queue = new QueueManager();
    const gate = deferred();
    const secondDone = deferred();

    queue.add(
      async () => {
        await gate.promise;
      },
      { namespace: "project-1" },
    );
    queue.add(
      async () => {
        secondDone.resolve();
      },
      { namespace: "project-2" },
    );

    // The first task holds the only slot, so the second stays queued.
    expect(queue.getTasks("project-1")).toHaveLength(1);
    expect(queue.getTasks("project-2")).toHaveLength(1);
    expect(queue.getTasks()).toHaveLength(2);

    gate.resolve();
    await secondDone.promise;
  }, 1000);

  test("a retried task runs again without duplicating its queue entry", async () => {
    const queue = new QueueManager();
    let attempts = 0;
    const retried = deferred();
    const finished = deferred();

    const task = queue.add(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error("boom");
        retried.resolve();
      },
      { retries: 1, retryDelay: 0 },
    );
    queue.on("success", (finishedTask) => {
      if (finishedTask.id === task.id) finished.resolve();
    });

    await retried.promise;
    await finished.promise;

    expect(attempts).toBe(2);
    expect(task.status).toBe("success");

    const ids = queue.getTasks().map((queued) => queued.id);
    expect(ids.filter((id) => id === task.id)).toHaveLength(1);
  }, 1000);

  test("an out-of-retries task ends in the error state with its message", async () => {
    const queue = new QueueManager();
    const failed = deferred();

    const task = queue.add(async () => {
      throw new Error("extraction failed");
    });
    queue.on("error", (errored) => {
      if (errored.id === task.id) failed.resolve();
    });

    await failed.promise;

    expect(task.status).toBe("error");
    expect(task.error).toBe("extraction failed");
  }, 1000);
});
