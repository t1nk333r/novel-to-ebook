import * as cheerio from "cheerio";
import { generateSelectors } from "../../lib/utils";
import { findContentSelector } from "./utils";

/**
 * Choosing a content selector without asking the operator.
 *
 * The whole-book flow used to demand CSS the operator had no way to know. The
 * heuristic already existed (`findContentSelector`, used by the snapshot route),
 * and so did model-based generation — what was missing is the part that decides
 * whether an answer is *good enough to walk two thousand pages with*.
 *
 * A wrong selector is not a small error: it is a catalogue's worth of navigation
 * links, or a catalogue's worth of empty chapters, discovered hours later. So no
 * candidate is used until it has been measured against a real chapter page.
 */

/** Text the extracted element(s) must hold before a candidate is trusted. */
export const MIN_EXTRACTED_CHARS = 200;

/**
 * Share of the page's own visible text the extraction must account for. A body
 * selector scores high; a nav block or a "related posts" strip scores a few
 * percent, which is exactly the mistake worth catching.
 */
export const MIN_TEXT_SHARE = 0.25;

export type SelectorScore = {
  matches: number;
  characters: number;
  share: number;
  /** Share of the extraction that sits inside <a>. Navigation is mostly links. */
  linkShare: number;
  ok: boolean;
  reason: string;
};

/**
 * Above this, the "chapter" is a list of links. The share test alone cannot see
 * it: a page of chapter links can easily be a quarter of the page's text.
 */
export const MAX_LINK_SHARE = 0.4;

export function scoreContentSelector(html: string, selectors: string[]): SelectorScore {
  const $ = cheerio.load(html);
  const clean = (value: string) => decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

  const bodyText = clean($("body").length ? $("body").text() : $.root().text());
  const bodyChars = bodyText.length;

  let matches = 0;
  let characters = 0;
  let linkCharacters = 0;
  const seen = new Set<string>();
  let text = "";
  let linkText = "";

  for (const selector of selectors) {
    if (!selector.trim() || seen.has(selector)) continue;
    seen.add(selector);
    let found: cheerio.Cheerio<never>;
    try {
      found = $(selector) as unknown as cheerio.Cheerio<never>;
    } catch {
      return {
        matches: 0,
        characters: 0,
        share: 0,
        linkShare: 0,
        ok: false,
        reason: `"${selector}" is not a valid selector`,
      };
    }
    matches += found.length;
    found.each((_, element) => {
      const $element = $(element);
      text += " " + clean($element.text());
      linkText += " " + clean($element.find("a").text());
    });
  }

  characters = clean(text).length;
  const share = bodyChars > 0 ? characters / bodyChars : 0;
  const linkShare = characters > 0 ? clean(linkText).length / characters : 0;
  const fail = (reason: string): SelectorScore => ({
    matches,
    characters,
    share,
    linkShare,
    ok: false,
    reason,
  });

  if (matches === 0) return fail("matches nothing on the page");
  if (characters < MIN_EXTRACTED_CHARS) {
    return fail(`extracts only ${characters} characters — too little to be a chapter`);
  }
  if (share < MIN_TEXT_SHARE) {
    return fail(
      `extracts ${Math.round(share * 100)}% of the page's text — that looks like navigation, not the chapter`,
    );
  }
  if (linkShare > MAX_LINK_SHARE) {
    return fail(
      `${Math.round(linkShare * 100)}% of the extraction is links — that is a chapter list, not a chapter`,
    );
  }

  return {
    matches,
    characters,
    share,
    linkShare,
    ok: true,
    reason: `${characters} characters, ${Math.round(share * 100)}% of the page, ${Math.round(linkShare * 100)}% links`,
  };
}

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (whole, code: string) => {
      const value = Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    });
}

/**
 * Descend from a candidate to the child that holds most of its text.
 *
 * The heuristic answers with the wrapper that dominates the *page* — on a
 * WordPress serial that was `div#content`, 91% of the page, which also contains
 * the site header. Chapter titles are read from the nearest heading before the
 * extracted element, so a superset makes every chapter in the book carry the
 * site's tagline as its title. The dominant child is the chapter itself.
 */
export function tightenSelector(html: string, selector: string): string {
  const $ = cheerio.load(html);
  const clean = (value: string) => decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

  let current = $(selector).first();
  if (!current.length) return selector;

  for (let depth = 0; depth < 6; depth++) {
    const own = clean(current.text()).length;
    if (own === 0) break;

    let best: cheerio.Cheerio<never> | null = null;
    let bestSize = 0;
    current.children().each((_, child) => {
      const size = clean($(child).text()).length;
      if (size > bestSize) {
        bestSize = size;
        best = $(child) as unknown as cheerio.Cheerio<never>;
      }
    });

    // Descend when one child holds most of the parent's text. The threshold was
    // 0.8, which stopped one level short of the real content on the WordPress
    // serial: `.entry-content` holds 75% of `#main`, so the import kept the
    // post's date row ("2 December 201728 December") at the top of every chapter.
    if (!best || bestSize / own < 0.75) break;
    current = best;
  }

  const element = current.get(0);
  if (!element) return selector;

  // No `CSS.escape` here: this runs on the server, where it does not exist.
  // Identifiers from real pages are matched directly, and anything odd falls
  // through to the tag or the caller's selector — never to a broken selector.
  const usableIdent = (value: string | undefined): value is string =>
    typeof value === "string" && /^[A-Za-z_][\w-]*$/.test(value);

  const candidate = (() => {
    const id = $(element).attr("id");
    if (usableIdent(id) && $(`#${id}`).length === 1) return `#${id}`;

    const tag = (element as { tagName?: string }).tagName?.toLowerCase();
    const className = ($(element).attr("class") ?? "").trim().split(/\s+/)[0];
    if (usableIdent(className)) {
      const byClass = `${tag}.${className}`;
      if ($(byClass).length >= 1) return byClass;
    }
    return tag ?? selector;
  })();

  return candidate;
}

export type SuggestedSelector = {
  selector: string;
  source: "heuristic" | "model";
  score: SelectorScore;
};

/**
 * The best selector for a chapter page, or null.
 *
 * The heuristic is tried first because it is free and instant; the model only
 * gets a turn when the page defeats it. Both answers go through the same scoring,
 * so a confident model cannot smuggle a bad selector past the caller.
 */
export async function suggestContentSelector(
  html: string,
  options: { useModel?: boolean } = {},
): Promise<SuggestedSelector | null> {
  const heuristic = findContentSelector(html)?.selector;
  if (heuristic) {
    // Tighten first: a superset passes the share test but drags the page's
    // chrome into every chapter of the book.
    const tightened = tightenSelector(html, heuristic);
    const options = tightened === heuristic ? [heuristic] : [tightened, heuristic];

    for (const candidate of options) {
      const score = scoreContentSelector(html, [candidate]);
      if (score.ok) return { selector: candidate, source: "heuristic", score };
    }
  }

  if (options.useModel === false) return null;

  try {
    const generated = await generateSelectors(html);
    const selectors = Array.isArray(generated.content) ? generated.content : [generated.content];
    const score = scoreContentSelector(html, selectors);
    if (score.ok) return { selector: selectors.join(", "), source: "model", score };
  } catch (error) {
    // A missing or failing provider must not stop the heuristic path from
    // working; the caller reports the failure if nothing validated.
    console.warn(
      `auto-selector: model unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  return null;
}
