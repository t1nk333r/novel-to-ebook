import { afterAll, describe, expect, test } from "bun:test";
import { chapterIdFromUrl } from "../src/app/projects/book-import";
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

/** One chapter, no id in the markup — what a WordPress serial serves. */
const SINGLE_PATH = "/2020/01/01/demo-novel-ch-7";
const singleChapter = `<!doctype html><html><body>
  <h1>Demo Novel ch.7</h1>
  <div class="entry-content"><p>Body seven.</p></div>
</body></html>`;

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: (request) =>
    new Response(
      new URL(request.url).pathname === SINGLE_PATH ? singleChapter : page(),
      { headers: { "content-type": "text/html" } },
    ),
});

afterAll(() => {
  server.stop(true);
});

describe.skipIf(!executablePath)("collectScrolledChapters", () => {
  test("a heading inside the block wins over a site heading before it", async () => {
    if (!executablePath) return;
    const browser = await launchBrowser(executablePath);

    try {
      const tab = await browser.newPage();
      // The shape that produced a book titled "Translating for fun": a header
      // h1 before the content, and the chapter's own heading inside it.
      await tab.setContent(`<!doctype html><html><body>
        <header><h1>Translating for fun</h1></header>
        <div class="entry-content"><h1>Glutton Berserker ch.7</h1><p>Body.</p></div>
      </body></html>`);

      const chapters = await collectScrolledChapters(tab, ".entry-content", { maxScrolls: 0 });
      expect(chapters).toHaveLength(1);
      expect(chapters[0]?.title).toBe("Glutton Berserker ch.7");
    } finally {
      await browser.close();
    }
  }, 60_000);

  test("takes the id from the URL when the page holds one chapter and stamps no id", async () => {
    if (!executablePath) return;
    const browser = await launchBrowser(executablePath);

    try {
      const tab = await browser.newPage();
      await tab.goto(`http://127.0.0.1:${PORT}${SINGLE_PATH}`, { waitUntil: "load" });

      const chapters = await collectScrolledChapters(tab, ".entry-content", {
        maxScrolls: 0,
      });

      expect(chapters).toHaveLength(1);
      expect(chapters[0]?.title).toContain("ch.7");
      // The in-page rule and the server's catalogue rule have to agree, or a
      // chapter read off a page can never match its catalogue entry — which is
      // what made every non-Webnovel walk import nothing.
      expect(chapters[0]?.id).toBe(chapterIdFromUrl(SINGLE_PATH));
      expect(chapters[0]?.id).toBe("demo-novel-ch-7");
    } finally {
      await browser.close();
    }
  }, 60_000);

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

describe.skipIf(!executablePath)("chapter titles", () => {
  const run = async (html: string) => {
    const browser = await launchBrowser(executablePath!);
    try {
      const tab = await browser.newPage();
      await tab.setContent(html);
      const chapters = await collectScrolledChapters(tab, ".entry-content", { maxScrolls: 0 });
      return chapters[0]?.title ?? null;
    } finally {
      await browser.close();
    }
  };

  test("a share widget's h2 does not beat the chapter h1 outside the block", async () => {
    // Titles came out "Bagikan ini" (Indonesian for "Share this") because a
    // heading inside the block won by position while the chapter's own h1 sat
    // just outside it.
    const title = await run(`<!doctype html><html><body>
      <h1>Glutton Berserker ch.7</h1>
      <div class="entry-content"><p>Body.</p><h2>Bagikan ini</h2></div>
    </body></html>`);
    expect(title).toBe("Glutton Berserker ch.7");
  }, 60_000);

  test("a heading inside the block wins when the ranks are equal", async () => {
    // The tagline case: the site's header h1 precedes every chapter, so the
    // chapter's own h1 — inside the block — has to win the tie.
    const title = await run(`<!doctype html><html><body>
      <h1>Translating for fun</h1>
      <div class="entry-content"><h1>Glutton Berserker ch.7</h1><p>Body.</p></div>
    </body></html>`);
    expect(title).toBe("Glutton Berserker ch.7");
  }, 60_000);
});
