import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer";
import { guardNavigations } from "../src/lib/browser";

/**
 * Wiring test for the document-navigation guard (plan 024).
 *
 * Chromium resolves DNS and follows redirects itself, so the per-call
 * `assertSafeOutboundUrl` covered only the entry URL. These tests drive the
 * real interception path against a loopback fixture — no public network — and
 * use the injectable `isAllowed` so the same fixture can prove both outcomes:
 * blocked when the policy refuses it, loaded when it does not. That is what
 * makes the test fail if the guard is removed rather than merely skipped.
 *
 * Runs wherever a browser is actually available: an explicit
 * `PUPPETEER_EXECUTABLE_PATH`, or the copy CI downloads during install. Skipped
 * only when neither exists (a local `--ignore-scripts` tree has no download).
 */
function findBrowser() {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured && existsSync(configured)) return configured;

  try {
    const bundled = puppeteer.executablePath();
    if (existsSync(bundled)) return bundled;
  } catch {
    // Not downloaded; fall through to skipping.
  }

  return undefined;
}

const executablePath = findBrowser();
const PORT = 3099;
const MARKER = "NAV-GUARD-FIXTURE";

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: () =>
    new Response(`<html><body><h1>${MARKER}</h1></body></html>`, {
      headers: { "content-type": "text/html" },
    }),
});

async function withPage<T>(
  isAllowed: ((url: string) => boolean) | undefined,
  run: (page: puppeteer.Page) => Promise<T>,
) {
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    // `undefined` exercises the default (the real outbound policy).
    await guardNavigations(page, { isAllowed });
    return await run(page);
  } finally {
    await browser.close();
  }
}

const target = `http://127.0.0.1:${PORT}/`;

afterAll(() => {
  server.stop(true);
});

describe.skipIf(!executablePath)("document navigation guard", () => {
  test("blocks a navigation the policy refuses", async () => {
    const result = await withPage(
      () => false,
      async (page) => {
        let failed: string | null = null;
        page.on("requestfailed", (request) => {
          if (request.isNavigationRequest()) {
            failed = request.failure()?.errorText ?? "unknown";
          }
        });

        let threw = false;
        await page
          .goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 })
          .catch(() => {
            threw = true;
          });

        let body = "";
        try {
          body = await page.evaluate(() => document.body?.innerText ?? "");
        } catch {
          // Navigation aborted: the execution context is gone, which is itself
          // the expected outcome.
        }

        return { threw, failed, body };
      },
    );

    expect(result.threw || result.failed !== null).toBe(true);
    expect(result.body).not.toContain(MARKER);
  }, 60_000);

  test("allows the same navigation when the policy permits it", async () => {
    const body = await withPage(
      () => true,
      async (page) => {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
        return await page.evaluate(() => document.body?.innerText ?? "");
      },
    );

    // Proves the fixture is reachable and that the previous test failed because
    // of the guard, not because the page was never servable.
    expect(body).toContain(MARKER);
  }, 60_000);

  test("defaults to the outbound policy when no predicate is injected", async () => {
    await expect(
      withPage(undefined, async (page) => {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
      }),
    ).rejects.toThrow();
  }, 60_000);
});
