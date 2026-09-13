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

/**
 * Site furniture that holds links which look like chapters but are not: menus
 * (other novels' landing pages), comment widgets, sidebars. Measured on a real
 * WordPress serial: of its 20 non-chapter links, 17 sat inside one of these and
 * of its 250 chapter links, none did.
 */
const CHROME_TAG = /^(nav|header|footer|aside)$/i;
const CHROME_CLASS = /(^|[-_])(menu|widget|sidebar|navigation|nav|breadcrumb)([-_]|$)/i;

const TIME_AGO =
  "(?:\\d+\\s*(?:years?|months?|weeks?|days?|hours?|minutes?|mins?|seconds?|secs?)\\s+ago|just\\s+now)";

/**
 * Arabic serials glue relative times to titles exactly as English ones do
 * ("الفصل 1" + "منذ ٣ أيام"), so the same cleanup is needed — with Arabic-Indic
 * digits, whose code points are not `\\d`.
 */
const ARABIC_TIME_AGO =
  "(?:منذ|قبل|مضت|مضى)\\s+(?:[0-9\\u0660-\\u0669\\u06F0-\\u06F9]+\\s*)?" +
  "(?:ثانية|ثوان|دقيقة|دقائق|ساعة|ساعات|يومين|يوم|أيام|ايام|أسبوعين|أسبوع|أسابيع|شهرين|شهر|أشهر|اشهر|سنتين|سنة|سنوات|عام|أعوام)";
const BRACKETED_TIME = new RegExp(`\\s*[([{]\\s*${TIME_AGO}\\s*[)\\]}]$`, "i");
const TRAILING_TIME = new RegExp(`\\s*[-–—,:;]?\\s*${TIME_AGO}$`, "i");
const TRAILING_SEPARATOR = /[\s–—,;:.-]+$/;
const ARABIC_BRACKETED = new RegExp(`\\s*[([{]\\s*${ARABIC_TIME_AGO}\\s*[)\\]}]$`, "i");
const ARABIC_TRAILING = new RegExp(`\\s*[-–—,:;]?\\s*${ARABIC_TIME_AGO}$`, "i");

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

    for (const pattern of [BRACKETED_TIME, TRAILING_TIME, ARABIC_BRACKETED, ARABIC_TRAILING]) {
      if (pattern.test(title)) {
        title = title.replace(pattern, "").replace(TRAILING_SEPARATOR, "").trim();
        changed = true;
      }
    }
  }

  return title.replace(TRAILING_SEPARATOR, "").trim();
}

/**
 * `/book/<slug>_<id>` — Webnovel's *book* page, which ends in an id exactly like
 * its chapter URLs do. The generic rule below must not read it as a chapter, or
 * a catalogue's "book home" link becomes chapter zero.
 */
const BOOK_URL = /\/book\/[^/]+_\d{6,}\/?$/;

export function chapterIdFromUrl(url: string) {
  const webnovel = url.match(CHAPTER_URL);
  if (webnovel) return webnovel[2];
  if (BOOK_URL.test(pathOf(url))) return null;

  return genericChapterId(url);
}

/**
 * Path segments that are never a chapter. A catalogue page is full of links —
 * menus, archives, comment anchors, the book's own page — and every one of them
 * has *a* last segment, so the id has to come with a guard or the walk would
 * import a site's sidebar.
 */
const NON_CHAPTER_PATH =
  /\/(?:page|comments?|feed|category|categories|tag|tags|author|search|attachment)\//i;

/** Relative hrefs are the common case inside a catalogue: never throw on them. */
function pathOf(url: string) {
  try {
    return new URL(url, "http://relative.invalid").pathname;
  } catch {
    return "";
  }
}

/** Words that mark a segment as a chapter even without a number ("prologue"). */
const CHAPTER_WORD =
  /(?:^|[^a-z])(?:ch|chap|chapter|part|vol|volume|ep|episode|prologue|epilogue|interlude|side[-_]?story|extra|bonus|afterword)(?:$|[^a-z\d])/i;

/**
 * Sites that put no id in the URL — every WordPress serial, most custom readers
 * — still need one: it is what makes a run resumable and what matches a chapter
 * read off a reader page to its catalogue entry. The last path segment serves,
 * when it plausibly names a chapter rather than a part of the site.
 */
function genericChapterId(url: string) {
  const path = pathOf(url);

  if (NON_CHAPTER_PATH.test(path)) return null;

  const segment = path.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!segment || segment.length > 120) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(segment)) return null;

  const isNumber = /^\d+$/.test(segment);
  const hasNumber = /\d/.test(segment);
  const hasLetter = /[a-z]/i.test(segment);

  // "2" is a chapter id on some readers and page 2 of an archive elsewhere;
  // `/page/` is already excluded above, so a bare number is taken as an id.
  if (isNumber) return segment;
  if (!hasLetter) return null;
  if (!hasNumber && !CHAPTER_WORD.test(segment)) return null;

  return segment.toLowerCase();
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

    // Chapters live on the site being catalogued. WordPress.com serials carry
    // utility links to its own reader on a different host, and those are not
    // chapters of anything.
    if (/^https?:\/\//i.test(href) && !href.startsWith(origin)) return;

    const id = chapterIdFromUrl(href);
    if (!id || seen.has(id)) return;

    const chain = [$el.attr("class") ?? ""];
    let inChrome = false;
    $el.parents().each((__, parent) => {
      const $parent = $(parent);
      chain.push($parent.attr("class") ?? "");
      if (CHROME_TAG.test((parent as { tagName?: string }).tagName ?? "")) {
        inChrome = true;
      }
    });
    if (inChrome) return;
    if (chain.some((value) => PROMO_CLASS.test(value) || CHROME_CLASS.test(value))) return;

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
