import { scanLibrary, type LibraryItems } from "./utils";

let library: LibraryItems = [];
let scanController: AbortController | null = null;
let scanGeneration = 0;

export type ScanResult = { ok: true } | { ok: false; error: Error };

/**
 * Rescan the library. A superseded scan (a newer rescan aborted this one) is
 * not a failure and reports success; a real failure is returned rather than
 * swallowed, so the rescan route can answer 500 instead of a green toast over
 * a stale library. Callers that do not care (the cron and the post-export
 * refresh) can ignore the result — it never rejects.
 */
export async function rescanLibrary(): Promise<ScanResult> {
  let controller: AbortController | null = null;
  let generation = 0;
  try {
    console.log("Scanning library...");

    scanController?.abort();
    controller = new AbortController();
    generation = ++scanGeneration;
    scanController = controller;

    const res = await scanLibrary([process.env.DATA_PATH || "./data"], {
      signal: controller.signal,
    });

    controller.signal.throwIfAborted();
    if (generation === scanGeneration) library = res;

    console.log("Library scanned!");
    return { ok: true };
  } catch (err) {
    if (controller?.signal.aborted || generation !== scanGeneration) {
      return { ok: true };
    }

    const error = err instanceof Error ? err : new Error(String(err));
    console.error("Cannot scan library!", error);
    return { ok: false, error };
  } finally {
    if (controller && scanController === controller) scanController = null;
  }
}

export function getLibrary() {
  return library;
}
