import { describe, expect, test } from "bun:test";
import {
  chapterIdFromClassName,
  chapterIdFromUrl,
  cleanImportedTitle,
  firstUnimportedIndex,
  parseCatalogChapters,
} from "../src/app/projects/book-import";

/**
 * Walking a whole book: the catalogue gives the ordered list, the reader pages
 * give the content, and chapters are tracked by source id so a run resumes.
 *
 * The catalogue fixture mirrors Webnovel's markup: a promo link to the newest
 * chapter above the list, then volume lists whose rows are anchors carrying the
 * title *and* the row's age.
 */
const CATALOG = `<html><body>
  <a class="ell lst-chapter dib" href="/book/endless_11766562205519505/the-end_82615177433904087">Chapter 2360: The End and New Beginnings</a>
  <div class="volume-item">
    <ol class="clearfix g_row content-list">
      <li class="g_col _6"><a class="c_000 db pr" href="/book/endless_11766562205519505/characters-updated_31594562287885163">Characters (Updated for Vol. 15)<span>7 years ago</span></a></li>
      <li class="g_col _6"><a class="c_000 db pr" href="/book/endless_11766562205519505/the-beginning_31586142793028464">1 The Beginning of the End. Part 1/2<span>7 years ago</span></a></li>
      <li class="g_col _6"><a class="c_000 db pr" href="/book/endless_11766562205519505/meeting-klyscha_31589149116630292">2 Meeting the Goddess Klyscha<span>7 years ago</span></a></li>
    </ol>
  </div>
</body></html>`;

describe("catalogue parsing", () => {
  test("lists the chapters in order, skipping the newest-chapter promo", () => {
    const chapters = parseCatalogChapters(
      CATALOG,
      "https://www.webnovel.com/book/endless_11766562205519505/catalog",
    );

    expect(chapters.map((c) => c.title)).toEqual([
      "Characters (Updated for Vol. 15)",
      "1 The Beginning of the End. Part 1/2",
      "2 Meeting the Goddess Klyscha",
    ]);
    // The promo link points at 2360 and must not jump the queue.
    expect(chapters.some((c) => c.id === "82615177433904087")).toBe(false);
  });

  test("keeps the timestamp out of the titles it stores", () => {
    const chapters = parseCatalogChapters(
      CATALOG,
      "https://www.webnovel.com/book/endless_11766562205519505/catalog",
    );

    expect(chapters.every((c) => !/years? ago/i.test(c.title))).toBe(true);
  });

  test("makes absolute URLs and stable ids", () => {
    const chapters = parseCatalogChapters(
      CATALOG,
      "https://www.webnovel.com/book/endless_11766562205519505/catalog",
    );

    expect(chapters[1]?.url).toBe(
      "https://www.webnovel.com/book/endless_11766562205519505/the-beginning_31586142793028464",
    );
    expect(chapters[1]?.id).toBe("31586142793028464");
  });

  test("collapses a chapter linked twice", () => {
    const twice = `<a href="/book/b_1/x_11111111111111111">One</a><a href="/book/b_1/x_11111111111111111">One again</a>`;
    expect(parseCatalogChapters(twice, "https://x.test/")).toHaveLength(1);
  });
});

describe("chapter identity", () => {
  test("reads the id from a chapter URL", () => {
    expect(
      chapterIdFromUrl(
        "/book/endless-path-infinite-cosmos_11766562205519505/the-beginning_31586142793028464",
      ),
    ).toBe("31586142793028464");
    expect(chapterIdFromUrl("/book/endless_11766562205519505/catalog")).toBeNull();
    expect(chapterIdFromUrl("/book/endless_11766562205519505")).toBeNull();
  });

  test("reads the id from a URL that has no id in it", () => {
    // Most sites are not Webnovel: a WordPress serial names its chapters by slug.
    // Without this the whole-book walk finds zero chapters outside one site.
    expect(
      chapterIdFromUrl("https://negaraizu.wordpress.com/2017/12/02/glutton-berserker-ch-1"),
    ).toBe("glutton-berserker-ch-1");
    expect(
      chapterIdFromUrl("/2019/08/25/glutton-berserker-ch-123"),
    ).toBe("glutton-berserker-ch-123");
    expect(chapterIdFromUrl("https://x.test/read/12345/")).toBe("12345");
    expect(chapterIdFromUrl("https://x.test/novel/prologue/")).toBe("prologue");
  });

  test("does not mistake site furniture for a chapter", () => {
    // A catalogue page is full of links. Every one of them has a last path
    // segment; reading one as a chapter imports a site's menu.
    for (const url of [
      "https://x.test/page/2/",
      "https://x.test/category/glutton-berserker/",
      "https://x.test/glutton-berserker/",
      "https://x.test/2026/08/05/patron-post-thank-you/comments",
      "https://x.test/feed/",
      "https://x.test/",
    ]) {
      expect(chapterIdFromUrl(url)).toBeNull();
    }
  });

  test("ignores links that leave the site being catalogued", () => {
    const html = `
      <div class="entry-content">
        <a href="/2020/01/01/some-novel-ch-1">Chapter 1</a>
        <a href="https://wordpress.com/reader/12345">View post in Reader</a>
      </div>`;
    const chapters = parseCatalogChapters(html, "https://x.test/some-novel/");

    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.url).toBe("https://x.test/2020/01/01/some-novel-ch-1");
  });

  test("ignores links inside menus, sidebars and comment widgets", () => {
    const html = `
      <nav><a href="/other-novel-ch-1">Another Novel</a></nav>
      <aside><a href="/2020/01/01/sidebar-novel-ch-2">Related</a></aside>
      <div class="widget"><a href="/2020/01/01/widget-novel-ch-3">Recent</a></div>
      <div class="entry-content"><a href="/2020/01/01/real-novel-ch-4">Chapter 4</a></div>`;
    const chapters = parseCatalogChapters(html, "https://x.test/some-novel/");

    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.title).toBe("Chapter 4");
  });

  test("reads the id from the reader's per-chapter wrapper class", () => {
    expect(
      chapterIdFromClassName(
        "chapter_content j_chapter_31593143606500080 para-comment-allowed",
      ),
    ).toBe("31593143606500080");
    expect(chapterIdFromClassName("cha-content")).toBeNull();
    expect(chapterIdFromClassName(null)).toBeNull();
  });

  test("agrees between the catalogue URL and the reader wrapper", () => {
    // This is what makes "already imported" work: both sides name the same id.
    const fromCatalog = chapterIdFromUrl("/book/x_1/y_31586142793028464");
    const fromReader = chapterIdFromClassName("j_chapter_31586142793028464");

    expect(fromCatalog).toBe(fromReader);
  });
});

describe("resuming", () => {
  const chapters = [
    { id: "1", title: "a", url: "u1" },
    { id: "2", title: "b", url: "u2" },
    { id: "3", title: "c", url: "u3" },
  ];

  test("points at the first chapter the project does not have", () => {
    expect(firstUnimportedIndex(chapters, [])).toBe(0);
    expect(firstUnimportedIndex(chapters, ["1"])).toBe(1);
    expect(firstUnimportedIndex(chapters, ["1", "2"])).toBe(2);
  });

  test("treats a finished book as complete, even with gaps behind it", () => {
    // Ids are the unit of progress, so a chapter imported out of order counts.
    expect(firstUnimportedIndex(chapters, ["2"])).toBe(0);
    expect(firstUnimportedIndex(chapters, ["1", "2", "3"])).toBe(-1);
  });
});

describe("cleanImportedTitle", () => {
  test("strips a glued, spaced, or bracketed timestamp", () => {
    expect(cleanImportedTitle("Characters (Updated for Vol. 15)7 years ago")).toBe(
      "Characters (Updated for Vol. 15)",
    );
    expect(cleanImportedTitle("Chapter 12 - 3 days ago")).toBe("Chapter 12");
    expect(cleanImportedTitle("Chapter 4 (1 month ago)")).toBe("Chapter 4");
    expect(cleanImportedTitle("Chapter 2360 Just now")).toBe("Chapter 2360");
  });

  test("leaves prose that mentions time alone", () => {
    expect(cleanImportedTitle("Chapter 3: Three Days Ago In The Rain")).toBe(
      "Chapter 3: Three Days Ago In The Rain",
    );
    expect(cleanImportedTitle("Chapter 6: Within the Western Forests (2/2)")).toBe(
      "Chapter 6: Within the Western Forests (2/2)",
    );
  });
});
