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

/** How many blocks at each edge are offered to the model. */
const EDGE_BLOCKS = 12;

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
    .replace(/&#39;/gi, "'");
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
 * The blocks the model is asked about: the edges only. Junk is appended and
 * prepended in every sample seen, and restricting the question means a confused
 * answer cannot reach the middle of a chapter.
 */
export function cleanupCandidates({ blocks }: ChapterBlocks, alreadyJunk: number[] = []) {
  const keep = (index: number) => !alreadyJunk.includes(index);

  const head = blocks
    .map((_, index) => index)
    .slice(0, EDGE_BLOCKS)
    .filter(keep);
  const tailStart = Math.max(0, blocks.length - EDGE_BLOCKS);
  const tail = blocks
    .map((_, index) => index)
    .slice(tailStart)
    .filter(keep);

  return [...new Set([...head, ...tail])].sort((a, b) => a - b);
}

export function buildCleanupMessages(chapterTitle: string, blocks: ChapterBlocks, candidates: number[]) {
  const listing = candidates
    .map((index) => {
      const text = decodeEntities(blocks.blocks[index]!.replace(/<[^>]*>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      return `[${index}] (${visibleLength(blocks.blocks[index]!).toString()} chars) ${text || "(empty)"}`;
    })
    .join("\n");

  return [
    {
      role: "user",
      text:
        "You are cleaning a translated web novel chapter before it is published as an ebook. " +
        "Below are blocks from the start and end of one chapter, each with an index. " +
        "Decide which blocks are NOT part of the story and must be removed: separator lines, " +
        "the translator's or scanlator's notes, requests to join Patreon/Discord, 'read ahead' " +
        "advertising, video or embed placeholders, site or comment-box furniture. " +
        "Keep every block that is narration, dialogue, or a chapter heading — when in doubt, keep it. " +
        'Reply with JSON only: {"remove": [indices], "reason": "one short sentence"}\n\n' +
        `Chapter: ${chapterTitle}\n\n${listing}`,
    },
  ];
}

export type CleanupDecision = { drop: number[]; reason: string; source: "ai" | "deterministic" };

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
): { html: string; dropped: number[]; refused: string | null } {
  const total = blocks.sizes.reduce((sum, size) => sum + size, 0);
  const valid = [...new Set(drop)].filter(
    (index) => Number.isInteger(index) && index >= 0 && index < blocks.blocks.length,
  );

  const dropped = valid.reduce((sum, index) => sum + (blocks.sizes[index] ?? 0), 0);
  if (total > 0 && dropped / total > maxRemovalShare) {
    const share = Math.round((dropped / total) * 100);
    return {
      html: blocks.blocks.join(""),
      dropped: [],
      refused: `would remove ${share}% of the chapter (cap ${Math.round(maxRemovalShare * 100)}%)`,
    };
  }

  const remove = new Set(valid);
  const kept = blocks.blocks.filter((_, index) => !remove.has(index));

  // Belt and braces: what is written must be built from the original blocks
  // verbatim. If that ever stops holding, refuse rather than write.
  const original = blocks.blocks.join("");
  for (const block of kept) {
    if (!original.includes(block)) {
      return { html: original, dropped: [], refused: "a retained block was not byte-identical" };
    }
  }

  return { html: kept.join(""), dropped: valid, refused: null };
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
    reason?: unknown;
  };

  const allowed = new Set(candidates);
  const drop = Array.isArray(parsed.remove)
    ? parsed.remove
        .filter((value): value is number => typeof value === "number")
        .filter((index) => allowed.has(index))
    : [];

  return { drop, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "", source: "ai" };
}

/** The model a cleanup run uses, from the environment. */
export function cleanupModelFromEnv(env: Record<string, string | undefined> = process.env) {
  return env.MISTRAL_CLEAN_MODEL?.trim() || DEFAULT_CLEAN_MODEL;
}

/** Exported so the route can name the default in its 503 message. */
export { DEFAULT_MISTRAL_MODEL };
