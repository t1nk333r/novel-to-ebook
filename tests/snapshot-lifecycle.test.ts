import { describe, expect, test } from "bun:test";
import { startPeriodicTask } from "../src/lib/periodic-task";

describe("snapshot periodic task", () => {
  test("does not overlap work and stops before returning", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const stop = startPeriodicTask(async () => {
      active++;
      calls++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(12);
      active--;
    }, 1);

    await Bun.sleep(8);
    await stop();
    const stoppedAt = calls;
    await Bun.sleep(8);

    expect(maxActive).toBe(1);
    expect(active).toBe(0);
    expect(calls).toBe(stoppedAt);
  });
});
