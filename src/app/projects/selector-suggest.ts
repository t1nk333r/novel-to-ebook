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
  ok: boolean;
  reason: string;
};

export function scoreContentSelector(html: string, selectors: string[]): SelectorScore {
  const $ = cheerio.load(html);
  const clean = (value: string) => decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

  const bodyText = clean($("body").length ? $("body").text() : $.root().text());
  const bodyChars = bodyText.length;

  let matches = 0;
  let characters = 0;
  const seen = new Set<string>();
  let text = "";

  for (const selector of selectors) {
    if (!selector.trim() || seen.has(selector)) continue;
    seen.add(selector);
    let found: cheerio.Cheerio<never>;
    try {
      found = $(selector) as unknown as cheerio.Cheerio<never>;
    } catch {
      return { matches: 0, characters: 0, share: 0, ok: false, reason: `"${selector}" is not a valid selector` };
    }
    matches += found.length;
    found.each((_, element) => {
      text += " " + clean($(element).text());
    });
  }

  characters = clean(text).length;
  const share = bodyChars > 0 ? characters / bodyChars : 0;

  if (matches === 0) {
    return { matches, characters, share, ok: false, reason: "matches nothing on the page" };
  }
  if (characters < MIN_EXTRACTED_CHARS) {
    return {
      matches,
      characters,
      share,
      ok: false,
      reason: `extracts only ${characters} characters — too little to be a chapter`,
    };
  }
  if (share < MIN_TEXT_SHARE) {
    return {
      matches,
      characters,
      share,
      ok: false,
      reason: `extracts ${Math.round(share * 100)}% of the page's text — that looks like navigation, not the chapter`,
    };
  }

  return { matches, characters, share, ok: true, reason: `${characters} characters, ${Math.round(share * 100)}% of the page` };
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
    const score = scoreContentSelector(html, [heuristic]);
    if (score.ok) return { selector: heuristic, source: "heuristic", score };
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
