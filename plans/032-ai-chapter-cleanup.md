# 032 — AI cleanup pass: keep the chapter, drop the rest

- **Status**: IN PROGRESS (2026-09-13)
- **Severity**: feature — chapter bodies carry publisher furniture that no class/id rule can match

## Why

`stripSiteChrome` removes furniture by matching class/id *tokens*. On the
WordPress serial this fails for everything the translator writes **inside** the
post body:

```html
<p>=====</p>
<p>=====</p>
<p>Random video from my channel:</p>
<span style="text-align:center"></span>
```

— separator lines, a video/embed placeholder, patron plugs, "read ahead on my
Patreon", Discord invites, comment boxes. Same class of problem on Webnovel
("EPIClogue", author notes) and on any site that appends a footer to the prose.
Text-level rules can chase this forever; a model reads it correctly the first
time.

## Design

**The model decides; the deletion is mechanical.** The chapter is split into its
top-level blocks, the model is shown the *edge* candidates (junk is at the edges
in every sample seen) and returns the indices to drop. Blocks are then deleted
whole — the retained HTML is byte-identical to the input, so a wrong answer costs
a missing or retained block, never rewritten prose.

Three guards, in order:

1. **Only edge blocks are candidates.** The middle of a chapter is never offered,
   so a chapter cannot be hollowed out by a bad answer.
2. **A removal cap.** If the answer would drop more than
   `CLEANUP_MAX_REMOVAL_SHARE` (default 30%) of the chapter's text, the answer is
   rejected and the chapter is left untouched and reported.
3. **Prose preservation is asserted, not assumed.** The retained blocks are
   checked to be a strict subset of the input before anything is written.

A deterministic pre-pass runs first and drops what is provably junk — separator
blocks, empty blocks, blocks whose only content is a promo link — so the model is
only asked about genuinely ambiguous blocks. That also means a run with no AI
configured still cleans the obvious cases (and says so).

**Model**: `MISTRAL_CLEAN_MODEL`, default `mistral-small-latest`. This is a
classification task on a handful of short blocks, not generation; the cheap model
is the right default, and 2,000+ chapters is a bill worth keeping small.
`AI_PROVIDER`/`MISTRAL_API_KEY` come from the same plumbing as selector
generation.

## Surface

- `POST /projects/:id/chapters/clean` — batch, bounded by `maxChapters`,
  `dryRun` to report what *would* go without writing. Enqueues one task per
  chapter on the shared queue, so the existing progress stream
  (`GET /projects/:id/chapters/import`) reports it with no new UI plumbing.
- Project config records `cleanedChapterIds`, so a second run skips them (same
  mechanism as the import ledger — no migration, because `kysely-codegen` cannot
  run in an `--ignore-scripts` tree).
- UI: a **Clean up** action next to Export, which states how many chapters are
  pending and confirms a dry run first.

## Evidence

- Pure tests: block splitting, the deterministic pre-pass, the cap, and the
  prose-preservation check (a drop index pointing at prose must be refused).
- A stubbed-fetch test for the Mistral call: only candidates are sent, JSON mode
  is requested, and an out-of-range or malformed answer is rejected rather than
  applied.
- Live: run against the imported Glutton Berserker chapters, with before/after
  word counts and the retained text shown to be a subsequence of the original.
