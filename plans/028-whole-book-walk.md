# Plan 028: Import a whole book, resuming where it stopped

> **Executor instructions**: Recorded post hoc, like 027. The operator asked for
> this after plan 027 made single-page scrolling import work: they wanted the
> 2,367-chapter novel behind one URL, not one URL per chapter. Read it for the
> design and the evidence, not as a dispatch.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/020-multi-select-content.md`, `plans/021-iframe-selectors.md`, `plans/027-scroll-import.md`
- **Category**: direction
- **Planned at**: 2026-09-12 (post hoc)
- **Implemented**: 2026-09-12

## Why this matters

Plan 027 imports every chapter a *reader page* loads — 7 to 13 per page load.
Doing that for a 2,367-chapter novel means knowing where to resume after each
page, which is what this plan adds: the catalogue supplies the ordered list,
reader pages supply the content, and a ledger of source chapter ids makes a run
resumable.

Measured on `endless-path-infinite-cosmos`: the catalogue links all 2,367
chapters in one page (our snapshot captures 2,367 chapter links from it), and a
reader page yields ~13 chapters per load. A bounded run imported 13 chapters in
20 s; resuming added the next 5 in 25 s with no duplicates.

## Design decisions

1. **The catalogue is the authority**, and the book page is only a signpost to
   it. A real bug came from the opposite order: the book page carries its own
   short preview of chapters, so a resumed run read that list, found everything
   in it already imported, and stopped while 2,350 chapters were still missing.
   The first non-empty parse is not good enough — the *catalogue's* list is.
2. **Chapters are tracked by source id**, taken from the catalogue URL tail
   (`..._31586142793028464`) and matched against the reader wrapper's class
   (`j_chapter_31586142793028464`). Titles would be a tempting key and a bad one:
   the catalogue writes "1 The Beginning of the End. Part 1/2" where the reader
   writes "Chapter 1: The Beginning of the End. Part 1/2".
3. **The ledger lives in the project's config JSON** (`importedChapterIds`), so
   there is no migration and no generated type to hand-edit — `kysely-codegen`
   cannot run in an `--ignore-scripts` tree.
4. **Each page load completes a run of chapters.** After processing the page for
   entry *i*, chapters *i…i+12* are in the ledger, so the walk jumps straight to
   the first entry still missing.
5. **A page can overshoot the requested count** — it renders what it renders —
   so the bound is checked per insert, not per page.
6. **The catalogue's extras are imported too.** It lists author notes, parody
   chapters and status pages alongside chapters; the walker takes the list as the
   site presents it rather than guessing what a "chapter" is.

## What landed

- `src/app/projects/book-import.ts` — pure, browser-free: `parseCatalogChapters`
  (ordered list, promo link dropped, duplicates collapsed, titles cleaned),
  `chapterIdFromUrl`, `chapterIdFromClassName`, `firstUnimportedIndex`, and
  `cleanImportedTitle`.
- `collectScrolledChapters` now returns each chapter's **source id** as well as
  its title and HTML (read from the wrapper's class, which is an ancestor of the
  match and therefore not in the returned HTML).
- `queueImportBook(...)` in `chapters/repository.ts` — reads the catalogue, reads
  the ledger, then loops: load the next unimported entry's page, collect every
  chapter it renders, insert the ones the ledger lacks, persist the ledger.
- `POST /projects/{projectId}/chapters/import-book` — `{ bookUrl, selector,
  framePath?, maxScrolls?, maxChapters? }` → `{ taskId }`.
- **Whole book** mode in the Add Chapter dialog: book/catalogue URL plus the
  content selector (picked once from any chapter with Link → Pick).
- `ProjectConfigSchema` gains `importedChapterIds`.
- The title cleaning keeps two copies on purpose — `cleanImportedTitle` server
  side (what gets stored) and `ui/src/app/projects/view/lib/link-title.ts` (the
  review list) — because the built image ships `src/` and `ui/dist` only, so the
  server cannot import from `ui/src`, and the UI bundle cannot import server
  values.

## Evidence

- Fresh project, `maxChapters: 6` → exactly 6 chapters (`Chapter 1 … Chapter 6`);
  resume with `maxChapters: 3` → 3 more, ledger at 9, no duplicate titles.
- Resume on a project holding chapters 1–13 → continued at the catalogue's next
  entries with no duplicates (13 → 18).
- 11 tests in `tests/book-import.test.ts` covering catalogue parsing (order,
  promo link, duplicates, stored titles), chapter identity (URL vs. wrapper class
  agreeing, which is what makes resume work), resume index arithmetic, and the
  title cleaner. Two of them caught real bugs: the **book** URL matched the
  chapter pattern (so a book link would have been imported as a chapter), and the
  glued timestamp ate the `2` of "Part 1/2".
- Full suite, typecheck, lint and build clean.

## Known limits

- The task holds a browser slot for its whole run — a full novel is ~30–60
  minutes — so browser-driven requests are refused with 429 during that time.
- Duplicate catalogue entries collapse by id, but a novel that legitimately
  repeats a chapter id (a re-published chapter) is imported once.
- No de-duplication against chapters imported by *other* paths: the ledger only
  knows what this importer wrote.

## Maintenance notes

- If a site changes its wrapper class, ids stop resolving and the ledger stops
  matching: the walk then re-imports. The `ID_PATTERN` in
  `collectScrolledChapters` and `chapterIdFromClassName` must stay in sync — they
  are the same rule on either side of the page boundary.
- A reviewer should confirm the ledger is written *after* the inserts (so an
  interrupted run re-imports at worst the page it was on) and that
  `releaseBrowser()` remains in the `finally`.
