import { CronJob } from "cron";
import { rescanLibrary } from "./app/library/context";

// rescanLibrary reports its own failures and never rejects; the scheduler has
// nobody to hand a result to.
async function scanQuietly() {
  await rescanLibrary();
}

export function initScheduler() {
  new CronJob("0 */5 * * * *", scanQuietly, null, true);

  scanQuietly();
}
