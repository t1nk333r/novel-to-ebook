import { scanLibrary, type LibraryItems } from "./utils";

let library: LibraryItems = [];
let scanController: AbortController | null = null;
let scanGeneration = 0;

export async function rescanLibrary() {
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
  } catch (err) {
    console.error("Cannot scan library!", err);
  } finally {
    if (controller && scanController === controller) scanController = null;
  }
}

export function getLibrary() {
  return library;
}
