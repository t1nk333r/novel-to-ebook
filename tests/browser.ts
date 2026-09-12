import { existsSync } from "node:fs";
import puppeteer from "puppeteer";

/**
 * The Chromium to drive in tests, or undefined when this machine has none.
 *
 * An explicit `PUPPETEER_EXECUTABLE_PATH`, or the copy CI downloads during
 * install — a local `--ignore-scripts` tree has no download, so browser tests
 * skip there rather than fail.
 */
export function findBrowser() {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured && existsSync(configured)) return configured;

  try {
    const bundled = puppeteer.executablePath();
    if (existsSync(bundled)) return bundled;
  } catch {
    // Not downloaded; the caller skips.
  }

  return undefined;
}

export async function launchBrowser(executablePath: string) {
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
}
