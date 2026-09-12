import { afterAll, describe, expect, test } from "bun:test";
import type { Page } from "puppeteer";
import { SelectorSchema } from "../src/app/projects/schema";
import { collectFrameElements, resolveFrame } from "../src/app/projects/utils";
import { findBrowser, launchBrowser } from "./browser";

/**
 * Plan 021: pages that render their chapter inside an <iframe> have to be
 * selectable and extractable.
 *
 * The schema and `resolveFrame` cases are pure. The last two need a real
 * browser because they are about the frame tree and the coordinate space the UI
 * overlay draws in — the parts a fake cannot honestly stand in for.
 */
const executablePath = findBrowser();
const PORT = 3096;

const INNER = `<html><body style="margin:0">
  <p id="target" style="margin:10px 0 0 5px">frame content</p>
</body></html>`;

const OUTER = `<html><body style="margin:0">
  <div style="height:40px">top</div>
  <iframe src="/inner.html" style="position:absolute;left:60px;top:120px;width:400px;height:300px;border:0"></iframe>
</body></html>`;

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: (req) =>
    new Response(new URL(req.url).pathname === "/inner.html" ? INNER : OUTER, {
      headers: { "content-type": "text/html" },
    }),
});

afterAll(() => {
  server.stop(true);
});

describe("framePath schema", () => {
  const base = { title: "A novel", content: "div.body" };

  test("is optional, so payloads written before frames keep working", () => {
    const parsed = SelectorSchema.parse(base);

    expect(parsed.framePath).toBeUndefined();
  });

  test("accepts an empty list and a path of segments", () => {
    expect(SelectorSchema.parse({ ...base, framePath: [] }).framePath).toEqual(
      [],
    );
    expect(
      SelectorSchema.parse({ ...base, framePath: ["iframe", "iframe:nth-of-type(2)"] })
        .framePath,
    ).toHaveLength(2);
  });

  test("rejects an empty segment and a path past the frame limit", () => {
    expect(SelectorSchema.safeParse({ ...base, framePath: [""] }).success).toBe(
      false,
    );

    const tooDeep = Array.from({ length: 9 }, (_, i) => `iframe:nth-of-type(${i + 1})`);
    expect(SelectorSchema.safeParse({ ...base, framePath: tooDeep }).success).toBe(
      false,
    );
  });
});

describe("resolveFrame", () => {
  // Minimal doubles: resolveFrame only walks frames, frame elements and
  // selectors, so a real Browser is not worth starting for this.
  const fakeFrame = (opts: {
    children?: unknown[];
    matches?: (selector: string) => boolean;
  }) => ({
    childFrames: () => opts.children ?? [],
    frameElement: async () =>
      opts.matches
        ? {
            evaluate: async (_fn: unknown, selector: string) =>
              opts.matches?.(selector) ?? false,
          }
        : null,
  });

  // Puppeteer's Page is a concrete class; a structural double cannot satisfy it
  // nominally, so this is the one place a cast is the honest option.
  const doc = (inner?: unknown) => {
    const main = fakeFrame({ children: inner ? [inner] : [] });
    return { mainFrame: () => main } as unknown as Page;
  };

  test("an absent or empty path is the main frame", async () => {
    const page = doc();
    expect(await resolveFrame(page, null)).toBe(page.mainFrame());
    expect(await resolveFrame(page, [])).toBe(page.mainFrame());
  });

  test("an unmatched segment names the segment it could not find", async () => {
    const page = doc(fakeFrame({ matches: () => false }));

    await expect(resolveFrame(page, ["iframe:nth-of-type(3)"])).rejects.toThrow(
      /iframe:nth-of-type\(3\)/,
    );
  });

  test("a matching segment resolves into the child frame", async () => {
    const child = fakeFrame({ matches: (selector) => selector === "iframe#main" });
    const page = doc(child);

    expect(await resolveFrame(page, ["iframe#main"])).toBe(child);
  });
});

describe.skipIf(!executablePath)("frame collection in a real browser", () => {
  test("elements inside a frame are offered, with a path and main-frame boxes", async () => {
    if (!executablePath) return;
    const browser = await launchBrowser(executablePath);
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });

      const elements = await collectFrameElements(page, false);

      // Main-frame content is still there and carries an empty path.
      const header = elements.find((el) => el.text === "top");
      expect(header).toBeDefined();
      expect(header?.framePath).toEqual([]);

      // The frame's content is now selectable, which is the whole point.
      const inFrame = elements.find((el) => el.text === "frame content");
      expect(inFrame).toBeDefined();
      expect(inFrame?.framePath).toEqual(["iframe:nth-of-type(1)"]);

      // And its box is in main-frame space: the iframe sits at (60,120) and the
      // paragraph at (5,10) inside it.
      const box = inFrame?.box as { x: number; y: number };
      expect(box.x).toBeCloseTo(60 + 5, 0);
      expect(box.y).toBeCloseTo(120 + 10, 0);

      // The path resolves back to the frame that produced it.
      const resolved = await resolveFrame(
        page,
        inFrame?.framePath as string[],
      );
      expect(await resolved.evaluate(() => document.body.innerText)).toContain(
        "frame content",
      );

      await page.close();
    } finally {
      await browser.close();
    }
  }, 60_000);
});
