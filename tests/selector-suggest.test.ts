import { describe, expect, test } from "bun:test";
import { isRtl } from "../src/lib/language";
import { scoreContentSelector, MIN_TEXT_SHARE } from "../src/app/projects/selector-suggest";
import { cleanImportedTitle } from "../src/app/projects/book-import";

/**
 * Plan 033: choosing a content selector without asking the operator, and the
 * Arabic/RTL pieces. The scorer is what makes an automatic choice safe — it is
 * the difference between "the app picked something" and "the app picked
 * something that will still be right on chapter 2,000".
 */

const PAGE = `<!doctype html><html><body>
  <nav><a href="/a">Home</a><a href="/b">Latest</a><a href="/c">Random</a></nav>
  <div class="entry-content">
    ${Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i} of the chapter, with enough text in it that the body dominates the page by any measure at all.</p>`).join("")}
  </div>
  <aside class="related"><a href="/x">Chapter 12</a><a href="/y">Chapter 13</a></aside>
</body></html>`;

describe("scoreContentSelector", () => {
  test("accepts the body and reports what it measured", () => {
    const score = scoreContentSelector(PAGE, [".entry-content"]);
    expect(score.ok).toBe(true);
    expect(score.matches).toBe(1);
    expect(score.share).toBeGreaterThan(MIN_TEXT_SHARE);
  });

  test("rejects navigation, which is the mistake that matters", () => {
    // A nav bar "matches" and returns text — a naive check would accept it and
    // then import menu links as two thousand chapters.
    const nav = scoreContentSelector(PAGE, ["nav"]);
    expect(nav.ok).toBe(false);
    expect(nav.reason).toMatch(/navigation|too little/);

    const related = scoreContentSelector(PAGE, [".related"]);
    expect(related.ok).toBe(false);
  });

  test("rejects a selector that matches nothing, and invalid CSS", () => {
    expect(scoreContentSelector(PAGE, [".nope"]).ok).toBe(false);
    expect(scoreContentSelector(PAGE, [".nope"]).reason).toMatch(/matches nothing/);
    expect(scoreContentSelector(PAGE, ["div::bogus("]).ok).toBe(false);
  });

  test("a union of selectors accumulates text but a bad one still fails", () => {
    const union = scoreContentSelector(PAGE, [".entry-content", ".related"]);
    expect(union.ok).toBe(true);
    expect(scoreContentSelector(PAGE, [".related", "nav"]).ok).toBe(false);
  });
});

describe("isRtl", () => {
  test("covers the right-to-left languages and their regional variants", () => {
    for (const language of ["ar", "ar-EG", "he", "fa", "ur", "ps", "sd"]) {
      expect(isRtl(language)).toBe(true);
    }
    for (const language of ["en", "id", "ja", "zh-CN", "tr", ""]) {
      expect(isRtl(language)).toBe(false);
    }
    expect(isRtl(null)).toBe(false);
    expect(isRtl(undefined)).toBe(false);
  });
});

describe("Arabic catalogue titles", () => {
  test("strips the relative time an Arabic serial glues to a title", () => {
    expect(cleanImportedTitle("الفصل 1 منذ ٣ أيام")).toBe("الفصل 1");
    // "قبل يومين" is a relative time and should go. "قبل" alone is the word
    // "before", so a title using it that way must survive — the pattern needs
    // the unit word, not just the preposition.
    expect(cleanImportedTitle("الفصل 12 قبل يومين")).toBe("الفصل 12");
    expect(cleanImportedTitle("الفصل 12 قبل الغروب")).toBe("الفصل 12 قبل الغروب");
    expect(cleanImportedTitle("الباب 5 منذ 3 ساعات")).toBe("الباب 5");
    expect(cleanImportedTitle("الفصل 7 (منذ أسبوع)")).toBe("الفصل 7");
  });

  test("leaves an Arabic title alone when there is no timestamp", () => {
    expect(cleanImportedTitle("الفصل الأول: البداية")).toBe("الفصل الأول: البداية");
  });
});
