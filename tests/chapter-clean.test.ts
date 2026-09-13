import { afterEach, describe, expect, test } from "bun:test";
import {
  applyCleanup,
  cleanupCandidates,
  decideCleanupWithMistral,
  deterministicJunk,
  hasFurniture,
  isSubsequence,
  removeVerbatimSpans,
  splitChapterBlocks,
} from "../src/lib/chapter-clean";

/**
 * Plan 032: the AI cleanup pass. The model decides which blocks are furniture;
 * the deletion is mechanical and guarded, so a wrong answer can only ever retain
 * or drop a whole block — never rewrite prose.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(reply: unknown, status = 200) {
  const calls: { body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify(reply), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const mistralReply = (content: unknown) => ({
  choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
});

/** The real shape from the WordPress serial. */
const PROSE = (line: string) =>
  `<p>${Array.from({ length: 8 }, (_, i) => `${line} sentence ${i + 1} of the paragraph, long enough that the prose dominates the chapter by any measure.`).join(" ")}</p>`;

const WORDPRESS_CHAPTER = `${PROSE("The blade came down and I rolled aside, heart hammering.")}
${PROSE("“You are slower than you were,” she said, and smiled.")}
<p>=====</p>
<p>=====</p>
<p>Random video from my channel:</p>
<span style="text-align:center"></span>
<div class="sharedaddy sd-like"><span>Like</span></div>
<p>Translator: Raizu</p>
<p>Editor: Xaga</p>`;

describe("splitChapterBlocks", () => {
  test("splits a WordPress chapter into its paragraphs", () => {
    const blocks = splitChapterBlocks(WORDPRESS_CHAPTER);
    expect(blocks.blocks).toHaveLength(9);
    expect(blocks.blocks[0]).toContain("blade came down");
    expect(blocks.sizes[0]).toBeGreaterThan(30);
  });

  test("keeps nested markup inside one block", () => {
    const blocks = splitChapterBlocks('<p>one <em>two</em> <strong>three</strong></p><p>four</p>');
    expect(blocks.blocks).toHaveLength(2);
    expect(blocks.blocks[0]).toBe("<p>one <em>two</em> <strong>three</strong></p>");
  });

  test("a chapter that is one container stays one block", () => {
    const blocks = splitChapterBlocks('<div><p>first</p><p>second</p></div>');
    expect(blocks.blocks).toHaveLength(1);
  });
});

describe("deterministicJunk", () => {
  test("catches separators, empties, promo lines and credits without a model", () => {
    const blocks = splitChapterBlocks(WORDPRESS_CHAPTER);
    const junk = deterministicJunk(blocks).map((i) => blocks.blocks[i]!.replace(/<[^>]*>/g, "").trim());

    expect(junk).toContain("=====");
    expect(junk).toContain("Random video from my channel:");
    expect(junk).toContain("Translator: Raizu");
    expect(junk).toContain("Editor: Xaga");
    // Never the prose.
    expect(junk.join(" ")).not.toContain("blade came down");
  });

  test("leaves prose that merely mentions a funding platform alone", () => {
    const blocks = splitChapterBlocks(
      `<p>He explained that the sponsor of the expedition had demanded results, and the patron of the house would not wait.</p>` +
        `<p>Join me on Patreon for early chapters</p>`,
    );
    const junk = deterministicJunk(blocks);

    expect(junk).toHaveLength(1);
    expect(blocks.blocks[junk[0]!]).toContain("Patreon");
  });
});

describe("cleanupCandidates", () => {
  test("offers the whole chapter, minus what is already provably furniture", () => {
    // This was edges-only until the corpus disproved the assumption behind it:
    // Webnovel puts `(A/N: …)` notes mid-chapter, and 223 survived a run that
    // never showed them to the model. Protection now comes from the guards, not
    // from asking a narrow question.
    const blocks = splitChapterBlocks(
      Array.from({ length: 60 }, (_, i) => `<p>paragraph ${i}</p>`).join("") + "<p>=====</p>",
    );
    const candidates = cleanupCandidates(blocks, deterministicJunk(blocks));

    expect(candidates).toContain(0);
    expect(candidates).toContain(30);
    expect(candidates).toContain(59);
    expect(candidates).not.toContain(60); // the separator, already dropped
  });
});

describe("applyCleanup", () => {
  test("deletes whole blocks and keeps the rest byte-identical", () => {
    const blocks = splitChapterBlocks(WORDPRESS_CHAPTER);
    const drop = deterministicJunk(blocks);
    const { html, dropped, refused } = applyCleanup(blocks, drop);

    expect(refused).toBeNull();
    expect(dropped.length).toBeGreaterThan(0);
    expect(html).toContain("blade came down");
    expect(html).toContain("she said, and smiled");
    expect(html).not.toContain("Random video");
    expect(html).not.toContain("Translator: Raizu");
  });

  test("refuses a removal that would gut the chapter", () => {
    // The failure this cap exists for: a model that decides everything is
    // furniture, or a block listing that mis-maps indices.
    const blocks = splitChapterBlocks(WORDPRESS_CHAPTER);
    const proseOnly = [0, 1];
    const everything = blocks.blocks.map((_, index) => index);

    const refused = applyCleanup(blocks, everything);
    expect(refused.refused).toMatch(/remove \d+%/);
    expect(refused.dropped).toEqual([]);
    expect(refused.html).toContain("blade came down");

    // The cap bounds damage by text share, not by intent: two prose paragraphs
    // here are more than a third of the text, so that too is refused.
    const partial = applyCleanup(blocks, proseOnly);
    expect(partial.refused).toMatch(/remove \d+%/);

    // Dropping one short block is under the cap and goes through.
    const small = applyCleanup(blocks, [8]);
    expect(small.refused).toBeNull();
    expect(small.dropped).toEqual([8]);
  });

  test("ignores out-of-range and duplicate indices", () => {
    const blocks = splitChapterBlocks(
      `<p>${"long prose ".repeat(40)}</p><p>short</p><p>${"more prose ".repeat(40)}</p>`,
    );
    const { dropped, refused } = applyCleanup(blocks, [1, 1, 99, -3]);

    expect(refused).toBeNull();
    expect(dropped).toEqual([1]);
  });
});

describe("decideCleanupWithMistral", () => {
  const config = { apiKey: "test-key", model: "test-model" };

  test("asks about the candidates only, in JSON mode", async () => {
    const calls = stubFetch(mistralReply({ remove: [2], reason: "separator" }));
    const blocks = splitChapterBlocks(
      Array.from({ length: 40 }, (_, i) => `<p>paragraph ${i}</p>`).join(""),
    );
    const candidates = cleanupCandidates(blocks);

    const decision = await decideCleanupWithMistral("Chapter 1", blocks, candidates, config);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toBe("test-model");
    expect(calls[0]?.body.response_format).toEqual({ type: "json_object" });

    const prompt = (calls[0]?.body.messages as { content: string }[])[0]!.content;
    expect(prompt).toContain("[0]");
    expect(prompt).toContain("[20]"); // mid-chapter blocks are offered now
    expect(prompt).toContain("removeSpans"); // and spans are requested
    expect(decision.drop).toEqual([2]);
  });

  test("discards indices that were never offered", async () => {
    // The model is not trusted to invent indices: only candidates are applied.
    stubFetch(mistralReply({ remove: [0, 999, -1], reason: "x" }));
    const blocks = splitChapterBlocks(
      Array.from({ length: 40 }, (_, i) => `<p>paragraph ${i}</p>`).join(""),
    );
    const candidates = cleanupCandidates(blocks);

    const decision = await decideCleanupWithMistral("Chapter 1", blocks, candidates, config);
    expect(decision.drop).toEqual([0]); // 999 and -1 do not exist
  });

  test("accepts a fenced reply and refuses a broken one", async () => {
    stubFetch(mistralReply('```json\n{"remove": [], "reason": "nothing"}\n```'));
    const blocks = splitChapterBlocks("<p>a</p>");
    await expect(
      decideCleanupWithMistral("t", blocks, [0], config).then((d) => d.drop),
    ).resolves.toEqual([]);

    stubFetch(mistralReply("not json at all"));
    await expect(decideCleanupWithMistral("t", blocks, [0], config)).rejects.toThrow();
  });

  test("a rejected key is reported by status and model, never echoed", async () => {
    stubFetch({ message: "Unauthorized" }, 401);
    const blocks = splitChapterBlocks("<p>a</p>");

    const error = (await decideCleanupWithMistral("t", blocks, [0], config).catch(
      (err: Error) => err,
    )) as Error;

    expect(error.message).toContain("401");
    expect(error.message).toContain("test-model");
    expect(error.message).not.toContain("test-key");
  });
});

describe("spans inside a block", () => {
  test("cuts a note out of a paragraph and leaves the rest untouched", () => {
    const html = `<p>He closed the door behind him. (A/N: I rewrote this scene, let me know!) She waited.</p>`;
    const { html: cleaned, removed } = removeVerbatimSpans(html, [
      "(A/N: I rewrote this scene, let me know!)",
    ]);

    expect(removed).toBe(1);
    expect(cleaned).toBe("<p>He closed the door behind him.  She waited.</p>");
  });

  test("matches text through HTML entities and inline markup", () => {
    // The model sees decoded text, the block holds entities and tags.
    const html = `<p>Thanks for reading — that&#8217;s all for now. (A/N: It&#8217;s fine!)</p>`;
    const { html: cleaned, removed } = removeVerbatimSpans(html, ["(A/N: It’s fine!)"]);

    expect(removed).toBe(1);
    expect(cleaned).toContain("that&#8217;s all for now");
    expect(cleaned).not.toContain("A/N");
  });

  test("ignores anything that is not verbatim — never fuzzy-matches", () => {
    const html = `<p>The note said (A/N: buy me a coffee) and then the story went on.</p>`;
    const { html: cleaned, removed } = removeVerbatimSpans(html, [
      "buy me coffee", // paraphrased: must not match
      "(A/N: totally different text)",
    ]);

    expect(removed).toBe(0);
    expect(cleaned).toBe(html);
  });

  test("removes several spans from the same block", () => {
    const html = `<p>One (A/N: first) two (A/N: second) three.</p>`;
    const { html: cleaned, removed } = removeVerbatimSpans(html, [
      "(A/N: first)",
      "(A/N: second)",
    ]);

    expect(removed).toBe(2);
    expect(cleaned).toBe("<p>One  two  three.</p>");
  });

  test("spans count towards the removal cap", () => {
    // A span is one cut, so the test needs a span that is a large share of the
    // chapter: a short chapter carrying a long note.
    const note = `(A/N: ${"support me on patreon ".repeat(12)})`;
    const blocks = splitChapterBlocks(`<p>He ran.</p><p>${note}</p>`);

    const refused = applyCleanup(blocks, [], undefined, [note]);
    expect(refused.refused).toMatch(/cap/);
    expect(refused.html).toContain("He ran.");

    // The same cut on a chapter where it is small goes through.
    const long = splitChapterBlocks(`<p>${"story text ".repeat(120)}</p><p>${note}</p>`);
    const allowed = applyCleanup(long, [], undefined, [note]);
    expect(allowed.refused).toBeNull();
    expect(allowed.spans).toBe(1);
    expect(allowed.html).not.toContain("patreon");
  });
});

describe("hasFurniture", () => {
  test("spots the signals a cleaned chapter should no longer carry", () => {
    expect(hasFurniture("<p>(A/N: hello)</p>")).toBe(true);
    expect(hasFurniture("<p>Translator: Raizu</p>")).toBe(true);
    expect(hasFurniture('<a href="https://paypal.me/Einlion">tip</a>')).toBe(true);
    expect(hasFurniture("<p>Discord Invite: https://discord.gg/abc</p>")).toBe(true);
    expect(hasFurniture("<p>He walked home in the rain.</p>")).toBe(false);
    expect(hasFurniture(null)).toBe(false);
  });
});

describe("isSubsequence", () => {
  test("the property the whole pass rests on", () => {
    // Deleting blocks and cutting spans both hold it; anything the model wrote
    // would not, which is why it is asserted before every write.
    expect(isSubsequence("<p>He ran.</p>", "<p>He ran. (A/N: buy me coffee)</p>")).toBe(true);
    expect(isSubsequence("<p>He ran.</p>", "<p>He ran.</p>")).toBe(true);
    expect(isSubsequence("<p>He sprinted.</p>", "<p>He ran.</p>")).toBe(false);
    expect(isSubsequence("<p>He ran!</p>", "<p>He ran.</p>")).toBe(false);
  });
});
