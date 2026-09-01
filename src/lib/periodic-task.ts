export type PeriodicTaskStop = () => Promise<void>;

export function startPeriodicTask(
  task: () => Promise<void>,
  intervalMs: number,
): PeriodicTaskStop {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      running = task().finally(() => {
        running = null;
        schedule();
      });
    }, intervalMs);
  };

  schedule();

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    await running;
  };
}
