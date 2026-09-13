import { describe, expect, test } from "bun:test";
import { isRtl } from "../src/lib/language";
import {
  MIN_TEXT_SHARE,
  scoreContentSelector,
  tightenSelector,
  MIN_TEXT_SHARE,
} from "../src/app/projects/selector-suggest";

/** Text an extraction would produce, for assertions about what it excludes. */
function coverage(html: string, selector: string) {
  const { load } = require("cheerio") as typeof import("cheerio");
  const $ = load(html);
  return $(selector).text().replace(/\s+/g, " ").trim();
}
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

describe("tightenSelector", () => {
  const WRAPPED = `<!doctype html><html><body>
    <div id="content">
      <header><h1>Translating for fun</h1></header>
      <div class="entry-content">
        ${Array.from({ length: 30 }, (_, i) => `<p>Sentence ${i} of the actual chapter, long enough to dominate its parent.</p>`).join("")}
      </div>
    </div>
  </body></html>`;

  test("descends past the page wrapper to the chapter itself", () => {
    // The failure this fixes: #content contains the site header, so the nearest
    // heading before the extraction is the site's tagline — and every chapter in
    // the book gets it as a title.
    const tightened = tightenSelector(WRAPPED, "#content");
    expect(tightened).not.toBe("#content");
    expect(tightened).toContain("entry-content");

    const score = scoreContentSelector(WRAPPED, [tightened]);
    expect(score.ok).toBe(true);
    // The site's tagline is outside the tightened extraction.
    expect(coverage(WRAPPED, tightened)).not.toContain("Translating for fun");
  });

  test("stops at the body when its children are the paragraphs", () => {
    const plain = `<div id="c"><p>one</p><p>two</p><p>three</p></div>`;
    expect(tightenSelector(plain, "#c")).toBe("#c");
  });
});

describe("link-dominated extractions", () => {
  test("a list of chapter links is not a chapter", () => {
    const list = `<!doctype html><html><body><div class="index">${Array.from(
      { length: 60 },
      (_, i) => `<a href="/c${i}">Chapter ${i} — an unusually long link label so the list is a large share of the page</a>`,
    ).join("")}</div></body></html>`;

    const score = scoreContentSelector(list, [".index"]);
    expect(score.ok).toBe(false);
    expect(score.reason).toMatch(/links/);
  });
});

describe("descent depth", () => {
  test("descends through a wrapper that also has metadata", () => {
    // The real shape: #main > .entry-content holds 75% of #main's text, the rest
    // being a post-date row. At a 0.8 threshold the walk stopped at #main and
    // every imported chapter began with the date.
    const PAGE = `<div id="main">
      <div class="post-date">2 December 201728 December 2017</div>
      <div class="entry-content">${Array.from({ length: 30 }, (_, i) => `<p>Chapter sentence ${i}, long enough to be the bulk of the page.</p>`).join("")}</div>
    </div>`;
    const tightened = tightenSelector(PAGE, "#main");
    expect(coverage(PAGE, tightened)).not.toContain("2 December");
  });
});

describe("reader direction", () => {
  test("the UI copy and the server copy agree on which languages are RTL", async () => {
    // Two copies on purpose — the UI bundle cannot import server values — so a
    // test is what keeps them in step. Drift would mean an Arabic book that
    // exports RTL but pages LTR in the reader, or the reverse.
    const server = await import("../src/lib/language");
    const ui = await import("../ui/src/lib/language");

    const languages = ["ar", "ar-EG", "he", "fa", "ur", "ps", "sd", "ug", "ku", "en", "id", "ja", "zh-CN", "tr", "", null, undefined];
    for (const language of languages) {
      expect(ui.isRtl(language as string | null | undefined)).toBe(
        server.isRtl(language as string | null | undefined),
      );
    }
    expect(ui.isRtl("ar")).toBe(true);
    expect(ui.isRtl("en")).toBe(false);
  });
});

describe("library book to project", () => {
  test("matches by the recorded export key first", async () => {
    const { matchProjectForKey } = await import("../ui/src/app/library/lib/match-project");
    const projects = [
      { id: "a", title: "Some Other Book", config: { exportedKeys: ["Berserk of Gluttony.epub"] } },
      { id: "b", title: "Berserk of Gluttony", config: null },
    ];
    expect(matchProjectForKey("Berserk of Gluttony.epub", projects)?.id).toBe("a");
  });

  test("falls back to the title, including a re-export's numeric suffix", async () => {
    const { matchProjectForKey } = await import("../ui/src/app/library/lib/match-project");
    const projects = [{ id: "p", title: "Endless Path : Infinite Cosmos", config: null }];

    // Books exported before the key was recorded still deserve the link.
    expect(matchProjectForKey("Endless Path : Infinite Cosmos.epub", projects)?.id).toBe("p");
    expect(matchProjectForKey("Endless Path : Infinite Cosmos 2.epub", projects)?.id).toBe("p");
    expect(matchProjectForKey("Some Unrelated Book.epub", projects)).toBeNull();
    expect(matchProjectForKey(".epub", projects)).toBeNull();
  });
});

describe("adopting an EPUB", () => {
  /** A stored-entry zip, built in code so the test needs no binary fixture. */
  function makeZip(entries: { name: string; text: string }[]) {
    const encoder = new TextEncoder();
    const locals: Uint8Array[] = [];
    const central: number[] = [];
    let offset = 0;

    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = encoder.encode(entry.text);
      const local = new Uint8Array(30 + name.length + data.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(8, 0, true); // stored
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true);
      local.set(name, 30);
      local.set(data, 30 + name.length);
      locals.push(local);

      const header = new Uint8Array(46 + name.length);
      const headerView = new DataView(header.buffer);
      headerView.setUint32(0, 0x02014b50, true);
      headerView.setUint16(10, 0, true); // stored
      headerView.setUint32(20, data.length, true);
      headerView.setUint32(24, data.length, true);
      headerView.setUint16(28, name.length, true);
      headerView.setUint32(42, offset, true);
      header.set(name, 46);
      central.push(...header);
      offset += local.length;
    }

    const centralBytes = new Uint8Array(central);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, entries.length, true);
    eocdView.setUint16(10, entries.length, true);
    eocdView.setUint32(12, centralBytes.length, true);
    eocdView.setUint32(16, offset, true);

    const total = offset + centralBytes.length + eocd.length;
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of [...locals, centralBytes, eocd]) {
      out.set(part, cursor);
      cursor += part.length;
    }
    return out;
  }

  test("reads spine order, skips the nav, and takes metadata", async () => {
    const { readEpub } = await import("../src/app/projects/adopt");
    const book = readEpub(
      makeZip([
        { name: "mimetype", text: "application/epub+zip" },
        { name: "META-INF/container.xml", text: `<container><rootfile full-path="OEBPS/content.opf"/></container>` },
        {
          name: "OEBPS/content.opf",
          text: `<package><metadata><dc:title>Adopted Book</dc:title><dc:creator>Someone</dc:creator><dc:language>ar</dc:language></metadata>
            <manifest>
              <item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>
              <item id="c1" href="1_one.xhtml" media-type="application/xhtml+xml"/>
              <item id="c2" href="2_two.xhtml" media-type="application/xhtml+xml"/>
            </manifest>
            <spine><itemref idref="nav"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
        },
        { name: "OEBPS/toc.xhtml", text: `<html><body><nav><a href="1_one.xhtml">One</a></nav></body></html>` },
        { name: "OEBPS/1_one.xhtml", text: `<html><head><title>From Title Tag</title></head><body><h1>Chapter One</h1><p>First.</p></body></html>` },
        { name: "OEBPS/2_two.xhtml", text: `<html><head><title>Untitled</title></head><body><p>Second, with no heading.</p></body></html>` },
      ]),
    );

    expect(book.title).toBe("Adopted Book");
    expect(book.author).toBe("Someone");
    expect(book.language).toBe("ar");
    // The nav is in the spine but is not a chapter.
    expect(book.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter One",
      "Untitled", // no heading: falls back to the document title
    ]);
    expect(book.chapters[0]?.html).toContain("First.");
    expect(book.chapters[1]?.html).toContain("no heading");
  });

  test("refuses something that is not an EPUB", async () => {
    const { readEpub } = await import("../src/app/projects/adopt");
    expect(() => readEpub(new TextEncoder().encode("not a zip at all"))).toThrow(/zip/);
  });
});
