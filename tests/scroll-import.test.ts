import { afterAll, describe, expect, test } from "bun:test";
import { collectScrolledChapters } from "../src/app/projects/utils";
import { findBrowser, launchBrowser } from "./browser";

/**
 * Reader pages that append the following chapters as you scroll (Webnovel loads
 * six more, taking the page from 4k to 42k pixels). The fixture mimics that
 * shape: each chapter is a `div.chapter_content` wrapper with its own heading
 * and a `div.cha-content` body, and the page appends one more on each scroll to
 * the bottom.
 *
 * Needs a browser; skipped where none is available (see tests/browser.ts).
 */
const executablePath = findBrowser();
const PORT = 3095;
const TOTAL = 6;
const INITIAL = 3;

const page = (): string => `<!doctype html><html><body style="margin:0">
  <div id="chapters">
    ${Array.from({ length: INITIAL }, (_, i) => chapter(i + 1)).join("")}
  </div>
  <script>
    let loaded = ${INITIAL};
    window.addEventListener("scroll", () => {
      const atBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;
      if (!atBottom || loaded >= ${TOTAL}) return;
      loaded += 1;
      const wrapper = document.createElement("div");
      wrapper.className = "chapter_content";
      wrapper.innerHTML =
        '<h1>Chapter ' + loaded + '</h1>' +
        '<div class="cha-content"><div class="cha-words"><p>Body ' + loaded + '</p></div></div>';
      document.getElementById("chapters").append(wrapper);
    });
  </script>
</body></html>`;

function chapter(n: number) {
  return `<div class="chapter_content" style="height:600px">
    <h1>Chapter ${n}</h1>
    <div class="cha-content"><div class="cha-words"><p>Body ${n}</p></div></div>
  </div>`;
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: () => new Response(page(), { headers: { "content-type": "text/html" } }),
});

afterAll(() => {
  server.stop(true);
});

describe.skipIf(!executablePath)("collectScrolledChapters", () => {
  test("scrolls until the page stops growing and returns every chapter in order", async () => {
    if (!executablePath) return;
    const browser = await launchBrowser(executablePath);

    try {
      const tab = await browser.newPage();
      await tab.setViewport({ width: 1280, height: 800 });
      await tab.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });

      const chapters = await collectScrolledChapters(tab, "div.cha-content", {
        maxScrolls: 10,
      });

      // Everything the page was willing to load, in document order.
      expect(chapters).toHaveLength(TOTAL);
      expect(chapters.map((c) => c.title)).toEqual(
        Array.from({ length: TOTAL }, (_, i) => `Chapter ${i + 1}`),
      );
      expect(chapters[0]?.html).toContain("Body 1");
      expect(chapters[TOTAL - 1]?.html).toContain(`Body ${TOTAL}`);

      await tab.close();
    } finally {
      await browser.close();
    }
  }, 60_000);

  test("honours the scroll bound", async () => {
    if (!executablePath) return;
    const browser = await launchBrowser(executablePath);

    try {
      const tab = await browser.newPage();
      await tab.setViewport({ width: 1280, height: 800 });
      await tab.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });

      // One scroll only: what was loaded initially, plus at most what that one
      // scroll brought in — never the whole page.
      const chapters = await collectScrolledChapters(tab, "div.cha-content", {
        maxScrolls: 1,
      });

      expect(chapters.length).toBeGreaterThanOrEqual(INITIAL);
      expect(chapters.length).toBeLessThan(TOTAL);

      await tab.close();
    } finally {
      await browser.close();
    }
  }, 60_000);

  test("returns nothing when the selector matches no chapter", async () => {
    if (!executablePath) return;
    const browser = await launchBrowser(executablePath);

    try {
      const tab = await browser.newPage();
      await tab.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });

      expect(await collectScrolledChapters(tab, "div.not-a-chapter")).toEqual([]);
      expect(await collectScrolledChapters(tab, [])).toEqual([]);

      await tab.close();
    } finally {
      await browser.close();
    }
  }, 60_000);
});
