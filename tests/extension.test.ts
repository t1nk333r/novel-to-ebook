import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import puppeteer from "puppeteer";
import type { Page } from "puppeteer";
import { findBrowser } from "./browser";

/**
 * The companion extension, driven the way a browser runs it.
 *
 * Chromium is launched with the extension loaded and the popup is opened as a
 * page (there is no API to open a real toolbar popup), which exercises the parts
 * that can go wrong: the service worker fetching the API **without CORS headers**
 * — the assumption the whole design rests on — and the page-side capture
 * functions, injected exactly as `chrome.scripting.executeScript` injects them.
 *
 * The API is a local double, so the test asserts the request the extension makes
 * rather than a server's reaction to it.
 */
const executablePath = findBrowser();
const PORT = 3094;

const captured: { body: string }[] = [];

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/projects") {
      return Response.json([{ id: "project-1", title: "Test Novel" }]);
    }

    if (url.pathname === "/api/projects/project-1/chapters/capture") {
      captured.push({ body: await request.text() });
      return Response.json({ id: 1, title: "Chapter 1" });
    }

    if (url.pathname === "/fixture") {
      return new Response(
        `<!doctype html><html><head><title>Site — Chapter 1</title></head><body>
           <nav class="site-nav"><a href="/">Home</a><a href="/next">Next</a></nav>
           <h1 class="cha-title">Chapter 1: The Beginning</h1>
           <div class="cha-content">
             <div class="cha-words"><p>${"prose ".repeat(200)}</p></div>
             <div class="m-thou">CREATORS' THOUGHTS</div>
             <div class="user-links-wrap">498 comments</div>
           </div>
           <script>window.tracker = 1</script>
         </body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
});

afterAll(() => {
  server.stop(true);
});

/**
 * Wait for a condition instead of guessing a duration: the worker takes a moment
 * to start, more when other browser tests are running beside this one.
 */
async function waitFor(popup: Page, condition: () => boolean, timeoutMs = 15_000) {
  await popup.waitForFunction(condition, { timeout: timeoutMs });
}

describe.skipIf(!executablePath)("companion extension", () => {
  test("worker fetches the API, capture posts the page, server cleans it", async () => {
    if (!executablePath) return;

    const extensionPath = path.resolve(import.meta.dir, "../extension");
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    try {
      const worker = await browser.waitForTarget(
        (target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
        { timeout: 15_000 },
      );
      const extensionId = new URL(worker.url()).host;

      // The page is open first, then the popup — the order a user works in, and
      // the popup reads the tab list when it opens.
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/fixture`, { waitUntil: "domcontentloaded" });

      const popup = await browser.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);

      // Point the extension at the double and save.
      await popup.evaluate((port) => {
        document.getElementById("serverUrl").value = `http://127.0.0.1:${port}`;
        document.getElementById("token").value = "test-token";
      }, PORT);
      await popup.click("#save");

      // Listing projects proves the worker's cross-origin fetch went through —
      // the API sends no CORS headers, so a page-context fetch would have failed.
      await waitFor(popup, () =>
        [...document.querySelectorAll("#project option")].some(
          (option) => option.textContent === "Test Novel",
        ),
      );

      // A chapter page in another tab, targetable from the popup's tab list.
      await popup.bringToFront();
      await popup.evaluate(() => {
        const select = document.getElementById("tab");
        const option = [...select.options].find((o) => o.textContent.includes("Chapter 1"));
        if (!option) throw new Error("fixture tab not listed");
        select.value = option.value;
        select.dispatchEvent(new Event("change"));
      });

      await popup.evaluate(() => {
        document.getElementById("selector").value = "div.cha-content";
      });
      await popup.click("#send");
      await waitFor(popup, () =>
        (document.getElementById("status")?.textContent ?? "").startsWith("Added"),
      );

      expect(captured).toHaveLength(1);
      const payload = JSON.parse(captured[0]!.body);

      // The title came from the heading above the content, not the page title.
      expect(payload.title).toBe("Chapter 1: The Beginning");
      // Captured markup is the element's own HTML, junk and all — cleaning is the
      // server's job, and this proves it arrives unmodified.
      expect(payload.html).toContain("cha-words");
      expect(payload.html).toContain("m-thou");
      expect(payload.url).toContain("/fixture");
    } finally {
      await browser.close();
    }
  }, 90_000);
});
