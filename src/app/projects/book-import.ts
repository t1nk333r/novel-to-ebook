import * as cheerio from "cheerio";

/**
 * Walking a whole book: the catalogue supplies the ordered chapter list, reader
 * pages supply the content (each renders several chapters), and chapters are
 * identified by their source id so a run can be resumed.
 *
 * Everything here is pure so it can be tested without a browser; the browser
 * orchestration lives in the chapters repository.
 */

export type CatalogChapter = {
  /** Source chapter id, taken from the URL tail. Stable across runs. */
  id: string;
  title: string;
  url: string;
};

/**
 * A chapter URL is `/book/<book-slug>_<bookId>/<chapter-slug>_<chapterId>`.
 * The second slash matters: the book page itself ends in `_<id>` too, so a
 * looser pattern would read a book link in the catalogue as a chapter.
 */
const CHAPTER_URL = /\/book\/[^/]+\/([^/]+)_(\d{6,})\/?$/;

/** Per-row chrome: the "latest chapter" promo link, not a list entry. */
const PROMO_CLASS = /(lst[-_]chapter|latest[-_]chapter|j_latest)/i;

const TIME_AGO =
  "(?:\\d+\\s*(?:years?|months?|weeks?|days?|hours?|minutes?|mins?|seconds?|secs?)\\s+ago|just\\s+now)";
const BRACKETED_TIME = new RegExp(`\\s*[([{]\\s*${TIME_AGO}\\s*[)\\]}]$`, "i");
const TRAILING_TIME = new RegExp(`\\s*[-–—,:;]?\\s*${TIME_AGO}$`, "i");
const TRAILING_SEPARATOR = /[\s–—,;:.-]+$/;

/**
 * Strip the relative timestamp a catalogue row glues to its title
 * ("Characters (Updated for Vol. 15)7 years ago").
 *
 * Applied where titles are *stored*, so every import path benefits. The UI keeps
 * its own copy for the review list before import
 * (`ui/src/app/projects/view/lib/link-title.ts`): the two cannot share code,
 * because the built server image ships `src/` and `ui/dist` only, and the UI
 * bundle cannot import server values.
 */
export function cleanImportedTitle(raw: string) {
  let title = raw.replace(/\s+/g, " ").trim();

  for (let changed = true; changed; ) {
    changed = false;

    for (const pattern of [BRACKETED_TIME, TRAILING_TIME]) {
      if (pattern.test(title)) {
        title = title.replace(pattern, "").replace(TRAILING_SEPARATOR, "").trim();
        changed = true;
      }
    }
  }

  return title.replace(TRAILING_SEPARATOR, "").trim();
}

export function chapterIdFromUrl(url: string) {
  return url.match(CHAPTER_URL)?.[2] ?? null;
}

/**
 * The chapter id a reader page puts on its per-chapter wrapper
 * (`div.chapter_content.j_chapter_31586142793028464`), so a chapter read out of a
 * page can be matched against the catalogue entry for it.
 */
export function chapterIdFromClassName(className: string | null | undefined) {
  return className?.match(/(?:^|\s)j?_?chapter_(\d{6,})(?:\s|$)/)?.[1] ?? null;
}

/** A child element whose *entire* text is a relative timestamp is metadata. */
const TIMESTAMP_ONLY = new RegExp(`^(?:${TIME_AGO})$`, "i");

/**
 * A catalogue row's anchor wraps the title and its age, and `text()` glues them
 * together — "1 The Beginning of the End. Part 1/2" plus "7 years ago" reads as
 * "Part 1/27 years ago", where the chapter's own `2` is indistinguishable from
 * the timestamp's `27`. So the metadata children are removed before the text is
 * read, and `cleanImportedTitle` only mops up rows that glue it in directly.
 */
function rowTitle(
  $: ReturnType<typeof cheerio.load>,
  el: ReturnType<ReturnType<typeof cheerio.load>>,
) {
  const clone = el.clone();
  clone.find("span, time, small, em, i").each((_, child) => {
    if (TIMESTAMP_ONLY.test($(child).text().trim())) $(child).remove();
  });

  return cleanImportedTitle(clone.text());
}

/**
 * The ordered chapter list from a catalogue page.
 *
 * Rows carry the chapter name and its age in the same anchor, and the page also
 * links the newest chapter as a promo above the real list — that link is dropped,
 * and duplicates collapse by id, so the result is the list a reader works
 * through.
 */
export function parseCatalogChapters(html: string, baseUrl: string) {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const chapters: CatalogChapter[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href") ?? "";
    const id = chapterIdFromUrl(href);
    if (!id || seen.has(id)) return;

    const chain = [$el.attr("class") ?? ""];
    $el.parents().each((__, parent) => {
      chain.push($(parent).attr("class") ?? "");
    });
    if (chain.some((value) => PROMO_CLASS.test(value))) return;

    const title = rowTitle($, $el);
    if (!title) return;

    seen.add(id);
    chapters.push({
      id,
      title,
      url: href.startsWith("http") ? href : origin + href,
    });
  });

  return chapters;
}

/**
 * Where to resume: the first catalogue entry the project does not have yet.
 * `-1` means the book is complete.
 */
export function firstUnimportedIndex(
  chapters: CatalogChapter[],
  importedIds: Set<string> | string[],
) {
  const done = importedIds instanceof Set ? importedIds : new Set(importedIds);
  return chapters.findIndex((chapter) => !done.has(chapter.id));
}
