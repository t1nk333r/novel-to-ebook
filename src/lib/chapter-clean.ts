import { aiExecutor } from "./bounded-executor";
import { limits } from "./limits";
import { DEFAULT_MISTRAL_MODEL } from "./ai-provider";

/**
 * AI cleanup pass: keep the chapter, drop what the publisher wrapped around it.
 *
 * `stripSiteChrome` can only match class/id tokens, so it cannot see the
 * furniture sites write *inside* the post body — separator lines, "Random video
 * from my channel", patron plugs, "read ahead", Discord invites, comment boxes.
 *
 * The split here is deliberate: the model decides *which* blocks are furniture,
 * and the deletion is mechanical. Retained blocks are byte-identical to the
 * input, so a bad answer costs a retained or dropped block, never rewritten
 * prose — which is the failure mode that would be unacceptable in a book.
 */

/** A chapter split into the blocks a reader would call "paragraphs". */
export type ChapterBlocks = {
  /** Outer HTML of each top-level block, in order. */
  blocks: string[];
  /** Visible-text length of each block, for the removal cap. */
  sizes: number[];
};

export const DEFAULT_CLEAN_MODEL = "mistral-small-latest";

/** A drop larger than this share of the chapter's text is refused outright. */
export const DEFAULT_MAX_REMOVAL_SHARE = 0.3;

const SEPARATOR_BLOCK = /^[\s\-=_*~•·.]{3,}$/;
const PROMO_LINK = /(patreon|ko-?fi|buymeacoffee|paypal|discord|subscribestar|liberapay)/i;
/**
 * Reader-directed requests, not bare keywords. A sentence of prose can contain
 * "patron", "sponsor" or "support" ("the patron of the house", "the sponsor of
 * the expedition") — matching those deleted story text in testing, which is the
 * one failure this feature must not have. Each alternative below needs the
 * imperative shape a publisher uses when talking to the reader.
 */
const PROMO_PHRASE =
  /(random video from my channel|read (ahead|the next chapter)|(first|early|advanced) (chapters|access) (on|at|for)|(join|support) (me|us) (on|at|via)|become a (patron|sponsor)|buy me a coffee|if you (like|enjoy) (my|this) (work|translation)|rate (this|the) (chapter|novel)|leave a (comment|review)|(discord|patreon|ko-?fi)\.(gg|com)|chapter schedule|release schedule)/i;

/**
 * Credits and schedule notes, which are short standalone blocks. Length-gated,
 * because "the editor said" inside a paragraph of prose is not furniture.
 */
const CREDIT_LINE =
  /^\s*(translator|editor|proofread(er)?|special thanks|thanks to|tl|pr|qc|raw provider|source|chapter schedule|release schedule)\s*[:\-–]/i;

/**
 * Split a chapter into top-level blocks.
 *
 * WordPress puts one paragraph per `<p>`; Webnovel puts everything inside a
 * single container with `<br>` breaks. Both are handled by treating the parsed
 * root's children as the blocks — a chapter that arrives as one block simply
 * yields one, which the cleanup then leaves alone.
 */
export function splitChapterBlocks(html: string): ChapterBlocks {
  const blocks: string[] = [];
  const sizes: number[] = [];

  // A tiny scanner rather than a DOM: this runs server-side on stored HTML and
  // must not pull a parser into the request path. Depth tracking is enough for
  // the shapes a chapter body actually has.
  const pattern = /<([a-z][a-z0-9]*)\b[^>]*>|<\/([a-z][a-z0-9]*)>|([^<]+)/gi;
  let depth = 0;
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const [text, openTag, closeTag, innerText] = match;

    if (openTag && !/^(br|hr|img|input|meta|link)$/i.test(openTag)) {
      if (depth === 0) start = match.index;
      depth++;
      continue;
    }
    if (closeTag) {
      if (depth === 0) continue;
      depth--;
      if (depth === 0) {
        const block = html.slice(start, match.index + text.length);
        blocks.push(block);
        sizes.push(visibleLength(block));
      }
      continue;
    }
    if (innerText && depth === 0 && innerText.trim()) {
      blocks.push(innerText);
      sizes.push(visibleLength(innerText));
    }
  }

  return { blocks, sizes };
}

/** Length of the text a reader would see in a block. */
export function visibleLength(block: string): number {
  return decodeEntities(block.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .length;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    // Numeric forms matter here, not just the named ones: a span the model
    // copied from decoded text has to be found in a block holding `&#8217;`.
    .replace(/&#(\d+);/g, (whole, code: string) => {
      const value = Number(code);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : whole;
    })
    .replace(/&#x([0-9a-f]+);/gi, (whole, code: string) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : whole;
    });
}

/**
 * Blocks that are provably furniture: separator lines, empty blocks, and blocks
 * whose entire content is a promo link or an embed placeholder. No model needed,
 * so this much works with no AI configured at all.
 */
export function deterministicJunk({ blocks }: ChapterBlocks): number[] {
  const junk: number[] = [];

  blocks.forEach((block, index) => {
    const text = decodeEntities(block.replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();

    if (!text) {
      junk.push(index);
      return;
    }
    if (SEPARATOR_BLOCK.test(text)) {
      junk.push(index);
      return;
    }
    // A block that is nothing but a link to a funding platform.
    const withoutLinks = block.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "").replace(/<[^>]*>/g, "").trim();
    if (!withoutLinks && PROMO_LINK.test(block)) {
      junk.push(index);
      return;
    }
    // Short blocks that read as publisher furniture rather than prose.
    if (text.length <= 160 && (PROMO_PHRASE.test(text) || CREDIT_LINE.test(text))) {
      junk.push(index);
      return;
    }
  });

  return junk;
}

/**
 * The blocks the model is asked about.
 *
 * This started as the edges only, on the theory that furniture lives at the ends.
 * Measuring the real corpus disproved it: Webnovel drops `(A/N: …)` notes in the
 * middle of chapters, and those survived — 223 of them in one book. So the whole
 * chapter is offered, and the guards (never rewrite prose, removal cap, verbatim
 * spans) are what keep a confident model from amputating a chapter, not a narrow
 * question.
 */
export function cleanupCandidates({ blocks }: ChapterBlocks, alreadyJunk: number[] = []) {
  return blocks.map((_, index) => index).filter((index) => !alreadyJunk.includes(index));
}

/** Blocks listed per request. Long chapters are covered; nothing is silently dropped. */
const MAX_LISTED_BLOCKS = 160;

export function buildCleanupMessages(chapterTitle: string, blocks: ChapterBlocks, candidates: number[]) {
  const listed = candidates.slice(0, MAX_LISTED_BLOCKS);
  const listing = listed
    .map((index) => {
      const text = decodeEntities(blocks.blocks[index]!.replace(/<[^>]*>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 400);
      return `[${index}] (${visibleLength(blocks.blocks[index]!).toString()} chars) ${text || "(empty)"}`;
    })
    .join("\n");

  return [
    {
      role: "user",
      text:
        "You are cleaning a translated web novel chapter before it is published as an ebook.\n" +
        "Below is the chapter, block by block, each with an index.\n\n" +
        "Remove what is NOT the story: separator lines, the translator's or scanlator's notes " +
        "(anything like `(A/N: ...)`, `Translator:`, `Editor:`, chapter-schedule and 'read ahead' " +
        "advertising), requests to join Patreon/Discord/Ko-fi, funding links (paypal.me, " +
        "patreon.com, ko-fi.com, discord.gg), video or embed placeholders, and site or comment-box " +
        "furniture.\n" +
        "Keep every block that is narration, dialogue, or a chapter heading — when in doubt, keep it.\n\n" +
        "Two ways to remove something:\n" +
        '  - "remove": whole block indices, for anything that is furniture end to end.\n' +
        '  - "removeSpans": exact strings copied *character for character* from inside a block. This is ' +
        "the common case and the one that is easy to miss: a note is usually tacked onto the end of a " +
        "sentence inside a story paragraph — `… he said, closing the door. (A/N: Sorry for the delay!)` " +
        "— or sits at the start of one. Look for `(A/N:`, `(A/N)`, `(Translator's note`, " +
        "`(Editor's note`, `(TL note`, `(T/N`, `(ED/N`, `Please support`, `Discord Invite:`, links to " +
        "patreon/paypal/ko-fi/discord, and 'read ahead' lines *anywhere* in the text, including " +
        "mid-paragraph, and return each one as its own span.\n" +
        "The string must appear verbatim in the text below, or it will be ignored. Never paraphrase, " +
        "never include the story text around it, and never retype punctuation — copy and paste it.\n" +
        "If a whole block is furniture, use `remove` instead; use `removeSpans` when the note shares a " +
        "block with narration.\n\n" +
        'Reply with JSON only: {"remove": [indices], "removeSpans": ["exact text"], "reason": "one short sentence"}\n\n' +
        `Chapter: ${chapterTitle}\n\n${listing}`,
    },
  ];
}

export type CleanupDecision = {
  drop: number[];
  /** Exact substrings to cut out of retained blocks, as returned by the model. */
  spans: string[];
  reason: string;
  source: "ai" | "deterministic";
};

/** A span longer than this is treated as an attempt to rewrite a chapter. */
const MAX_SPAN_LENGTH = 400;
const MAX_SPANS = 25;

/**
 * Decoded-text offsets for one block, so a span the model copied from *text* can
 * be cut out of *HTML* without disturbing anything around it.
 *
 * Each entry records where in the HTML the character starts and how many HTML
 * characters produced it, which is what makes entity-decoded text (`&#8217;`)
 * map back to the right region.
 */
function textOffsets(html: string) {
  const starts: number[] = [];
  const lengths: number[] = [];
  let text = "";
  let index = 0;

  while (index < html.length) {
    const character = html[index]!;

    if (character === "<") {
      const close = html.indexOf(">", index);
      index = close === -1 ? html.length : close + 1;
      continue;
    }

    if (character === "&") {
      const entity = /^&(#\d+|#x[0-9a-f]+|[a-z]+);/i.exec(html.slice(index, index + 12));
      if (entity) {
        const decoded = decodeEntities(entity[0]);
        for (let i = 0; i < decoded.length; i++) {
          starts.push(index);
          lengths.push(entity[0].length);
        }
        text += decoded;
        index += entity[0].length;
        continue;
      }
    }

    starts.push(index);
    lengths.push(1);
    text += character;
    index += 1;
  }

  return { text, starts, lengths };
}

/**
 * Cut exact substrings out of a block, leaving every other character untouched.
 *
 * This is the only path by which cleanup touches content *inside* a block, and it
 * is deliberately literal: a span that is not found verbatim is skipped, never
 * fuzzy-matched. A model that paraphrases therefore removes nothing rather than
 * rewriting a sentence.
 */
export function removeVerbatimSpans(html: string, spans: string[]) {
  const offsets = textOffsets(html);
  let text = offsets.text;
  let result = html;
  let removed = 0;

  for (const span of spans) {
    if (!span || span.length > MAX_SPAN_LENGTH) continue;

    const at = text.indexOf(span);
    if (at === -1) continue;

    const from = offsets.starts[at]!;
    const last = at + span.length - 1;
    const to = offsets.starts[last]! + offsets.lengths[last]!;

    result = result.slice(0, from) + result.slice(to);
    // Keep the two views in step for the next span.
    text = text.slice(0, at) + text.slice(at + span.length);
    const step = to - from;
    for (let i = at; i < offsets.starts.length - span.length; i++) {
      offsets.starts[i] = offsets.starts[i + span.length]! - step;
      offsets.lengths[i] = offsets.lengths[i + span.length]!;
    }
    offsets.starts.length = Math.max(0, offsets.starts.length - span.length);
    offsets.lengths.length = offsets.starts.length;
    removed += 1;
  }

  return { html: result, removed };
}

/**
 * Is `text` obtainable from `source` by deleting characters only?
 *
 * Exported because it is the invariant the whole pass rests on: the model
 * chooses what to drop, never what to write.
 */
export function isSubsequence(text: string, source: string) {
  let cursor = 0;
  for (let i = 0; i < text.length; i++) {
    cursor = source.indexOf(text[i]!, cursor);
    if (cursor === -1) return false;
    cursor += 1;
  }
  return true;
}

export { MAX_SPAN_LENGTH, MAX_SPANS, textOffsets };

/**
 * Apply a decision, or refuse it.
 *
 * The guards live here rather than at the call site so every path — AI,
 * deterministic, or a `dryRun` preview — is subject to the same rules.
 */
export function applyCleanup(
  blocks: ChapterBlocks,
  drop: number[],
  maxRemovalShare = DEFAULT_MAX_REMOVAL_SHARE,
  spans: string[] = [],
): { html: string; dropped: number[]; spans: number; refused: string | null } {
  const total = blocks.sizes.reduce((sum, size) => sum + size, 0);
  const valid = [...new Set(drop)].filter(
    (index) => Number.isInteger(index) && index >= 0 && index < blocks.blocks.length,
  );

  // Apply the spans first: they are inside blocks, so their contribution to the
  // cap has to be counted before deciding whether the whole answer is allowed.
  let spanCharacters = 0;
  const withSpans = blocks.blocks.map((block, index) => {
    if (valid.includes(index) || spans.length === 0) return block;
    const applied = removeVerbatimSpans(block, spans);
    if (applied.removed > 0) {
      spanCharacters += visibleLength(block) - visibleLength(applied.html);
    }
    return applied.html;
  });

  const dropped =
    valid.reduce((sum, index) => sum + (blocks.sizes[index] ?? 0), 0) + spanCharacters;
  if (total > 0 && dropped / total > maxRemovalShare) {
    const share = Math.round((dropped / total) * 100);
    return {
      html: blocks.blocks.join(""),
      dropped: [],
      spans: 0,
      refused: `would remove ${share}% of the chapter (cap ${Math.round(maxRemovalShare * 100)}%)`,
    };
  }

  const remove = new Set(valid);
  const kept = withSpans.filter((_, index) => !remove.has(index));
  const html = kept.join("");

  // Belt and braces, and the whole safety claim in one line: what gets written
  // must be a character-level subsequence of what was read. Deleting blocks and
  // cutting spans both preserve that; anything the model *wrote* would not. A
  // substring check cannot express this once spans are cut out of a block.
  if (!isSubsequence(html, blocks.blocks.join(""))) {
    return {
      html: blocks.blocks.join(""),
      dropped: [],
      spans: 0,
      refused: "the result would not be a subsequence of the original chapter",
    };
  }

  return {
    html,
    dropped: valid,
    spans: withSpans.some((block, index) => block !== blocks.blocks[index]) ? 1 : 0,
    refused: null,
  };
}

/**
 * Ask the model which candidate blocks to drop. The answer is validated here —
 * indices outside the candidate list are dropped, not trusted.
 */
export async function decideCleanupWithMistral(
  chapterTitle: string,
  blocks: ChapterBlocks,
  candidates: number[],
  config: { apiKey: string; model?: string },
): Promise<CleanupDecision> {
  const model = config.model?.trim() || DEFAULT_CLEAN_MODEL;

  const response = await aiExecutor.run(() =>
    fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        // Mistral wants `content`; `buildCleanupMessages` returns `text` for the
        // Gemini-shaped callers. Sending it unmapped 400s.
        messages: buildCleanupMessages(chapterTitle, blocks, candidates).map(
          ({ role, text }) => ({ role, content: text }),
        ),
        response_format: { type: "json_object" },
        stream: false,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(limits.aiRequestTimeoutMs),
    }),
  );

  if (!response.ok) {
    // Status and model only: a body can echo chapter content.
    throw new Error(`Mistral cleanup failed with ${response.status} from model ${model}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Mistral returned no message content from ${model}`);
  }

  const parsed = JSON.parse(content.replace(/^```(?:json)?|```$/gm, "").trim()) as {
    remove?: unknown;
    removeSpans?: unknown;
    reason?: unknown;
  };

  const allowed = new Set(candidates);
  const drop = Array.isArray(parsed.remove)
    ? parsed.remove
        .filter((value): value is number => typeof value === "number")
        .filter((index) => allowed.has(index))
    : [];

  const spans = Array.isArray(parsed.removeSpans)
    ? parsed.removeSpans
        .filter((value): value is string => typeof value === "string")
        .filter((value) => value.trim().length > 0 && value.length <= MAX_SPAN_LENGTH)
        .slice(0, MAX_SPANS)
    : [];

  return {
    drop,
    spans,
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "",
    source: "ai",
  };
}

/**
 * Does this chapter still contain publisher furniture?
 *
 * The cleanup ledger records what has been *attempted*, not what is clean — a
 * chapter refused by the removal cap, or one whose note sits inside a paragraph,
 * is marked done and would never be reconsidered. This asks the text instead, so
 * a better pass (or a re-run) picks up exactly the chapters that still show
 * signs of it.
 */
const FURNITURE_SIGNAL =
  /(\(A\/N[:)]|translator\s*:|editor\s*:|patreon\.com|paypal\.me|ko-?fi\.com|discord\.gg|read ahead|advanced chapters)/i;

export function hasFurniture(html: string | null | undefined) {
  return FURNITURE_SIGNAL.test(html ?? "");
}

/**
 * Story chapter, or an announcement dressed as one? Used to decide whether a
 * "chapter" that is 100% notes belongs in the book at all — the cap refuses to
 * empty it, which is right, but leaves it as a chapter made of nothing.
 */
export async function classifyChapterWithMistral(
  title: string,
  excerpt: string,
  config: { apiKey: string; model?: string },
): Promise<{ story: boolean; reason: string }> {
  const model = config.model?.trim() || DEFAULT_CLEAN_MODEL;

  const response = await aiExecutor.run(() =>
    fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content:
              "This is a chapter of a translated web novel. Decide whether it contains story " +
              "(narration, dialogue, or a scene) or whether it is only an announcement, notice, " +
              "schedule update, or author's afterword dressed up as a chapter. " +
              'Reply with JSON only: {"story": true|false, "reason": "one short sentence"}.\n\n' +
              `Title: ${title}\n\n${excerpt.slice(0, 1500)}`,
          },
        ],
        response_format: { type: "json_object" },
        stream: false,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(limits.aiRequestTimeoutMs),
    }),
  );

  if (!response.ok) {
    throw new Error(`Mistral classification failed with ${response.status} from model ${model}`);
  }

  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Mistral returned no message content from ${model}`);

  const parsed = JSON.parse(content.replace(/^```(?:json)?|```$/gm, "").trim()) as {
    story?: unknown;
    reason?: unknown;
  };

  return {
    story: parsed.story !== false,
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "",
  };
}

/** The model a cleanup run uses, from the environment. */
export function cleanupModelFromEnv(env: Record<string, string | undefined> = process.env) {
  return env.MISTRAL_CLEAN_MODEL?.trim() || DEFAULT_CLEAN_MODEL;
}

/** Exported so the route can name the default in its 503 message. */
export { DEFAULT_MISTRAL_MODEL };
