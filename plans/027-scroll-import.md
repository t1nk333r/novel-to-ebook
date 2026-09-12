# Plan 027: Import the chapters a reader page loads while scrolling

> **Executor instructions**: This plan is written after the fact, recording work
> that landed at commit `5a6a52b`-era under a direct operator request ("build it:
> pull the scroll-loaded chapters into the import queue"). It exists so the
> design decisions and their evidence survive. Read it as a record, not as a
> dispatch.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/020-multi-select-content.md`, `plans/021-iframe-selectors.md`, `plans/024-per-navigation-ssrf.md`
- **Category**: direction
- **Planned at**: 2026-09-12 (post hoc)
- **Implemented**: 2026-09-12

## Why this matters

Some reader sites serve a chapter and then append the following ones as the
reader scrolls, so a single URL can carry a dozen chapters. Measured on the
Webnovel chapter used throughout this plan set: **1 chapter container at load,
7 after scrolling to the bottom**, page height 4,436 → 41,710 px, each chapter
appended as another `div.chapter_content` with the same classes the first one
uses.

Before this plan the operator imported those chapters one URL at a time, and the
only alternative — the link importer — needs a table-of-contents page that such
sites often paginate or virtualise anyway.

## Current state (before)

- `queueImportChapters` (`chapters/repository.ts`) takes a list of links and
  re-navigates for each one, extracting with `tryExtractContent`.
- The snapshot route never scrolls, deliberately: scrolling would pull the
  lazy-loaded chapters into the element tree and offer them to the picker on a
  screenshot that does not contain them (recorded at `routes.ts` near the
  `window.scrollTo(0, 0)` call).
- `limits.scrollLoads` (`MAX_SCROLL_LOADS`, default 12) bounds the new work.
- `stripSiteChrome` (plan from the same day) removes publisher furniture; each
  chapter container carries two such blocks on this site (`.m-thou`,
  `.user-links-wrap`).

## Design decisions

1. **One selector match = one chapter.** The caller's content selector decides
   what a chapter is, which keeps this site-agnostic: on Webnovel the operator
   picks `div.cha-content` and gets every chapter on the page.
2. **Read the rendered DOM; do not re-fetch per chapter.** The page has already
   rendered every chapter, so nothing is navigated again. That is faster (7
   chapters in ~10 s against ~4 s *per chapter* for the link importer) and it is
   the only reliable way to reach chapters a site exposes purely through
   scrolling.
3. **Titles come from the nearest heading *before* each match in document
   order**, because that is where these sites put them — the match itself opens
   with prose (`div.cha-words`) or with publisher furniture.
4. **Reuse the existing import queue** (`importQueue`, namespaced by project),
   so the progress panel, the browser-slot accounting and the chapter ordering
   rules all apply without new machinery.
5. **Bounded scrolling**: stop as soon as the page stops growing, and never
   exceed `MAX_SCROLL_LOADS`, so a page without lazy loading costs one
   measurement and a pathological page cannot loop forever.

## What landed

- `collectScrolledChapters(page, selectors, { framePath, maxScrolls })` in
  `src/app/projects/utils.ts` — scrolls the resolved frame (plan 021) until the
  height stops growing, then returns one `{ title, html }` per match, deduped
  across selectors and in document order.
- `queueImportScrolledChapters(...)` in `chapters/repository.ts` — navigates
  once, collects, strips chrome, sanitizes with `cleanHTML`, applies the
  project's font map (and persists a new one), and inserts each chapter with
  `insertChapterAtNextIndex`.
- `POST /projects/{projectId}/chapters/import-scroll` — `{ url, selector,
  framePath?, maxScrolls? }` → `{ taskId }`, mirroring the link import route.
- The Add Chapter dialog's Link mode gains **"Import every chapter this page
  loads"**; ticking it switches the button to *Import all* and posts to the new
  route with the same URL/selector fields the single-chapter flow uses.
- `MAX_SCROLL_LOADS` documented in `.env.example`.

## Evidence

- Live, API: one request with `maxScrolls: 6` imported **7 chapters**, titles
  `Chapter 1: The Beginning of the End. Part 1/2` … `Chapter 7: Within the
  Western Forests (2/2)`, 1,211–2,160 words each, **zero** containing site
  furniture; the exported EPUB carried a 7-entry TOC.
- Live, UI: the checkbox is present, flips the button to *Import all*, fires the
  request and toasts; a fresh project then showed **13 chapters** (the default
  12-scroll bound reaching further than the API test's 6).
- `tests/scroll-import.test.ts` (browser-gated, fixture that appends a chapter
  per scroll): collects every appended chapter in order with the right titles,
  honours `maxScrolls`, and returns nothing for a selector that matches nothing.
- Full suite 136 tests, typecheck, lint and build clean.

## Known limits

- Chapters taken this way do not pass through `tryExtractContent`, so the
  Readability/selector fallbacks do not apply and font-obfuscation handling is
  limited to applying the project's existing map.
- No de-duplication: importing the same page twice appends the chapters again.
- The scroll wait is a fixed 900 ms per step; a slow site may need more, and the
  bound is what stops a page that never settles.

## Maintenance notes

- A reviewer should check that `releaseBrowser()` stays in the `finally` — a
  leaked browser slot blocks every later browser-driven feature — and that no
  chapter content reaches a log line.
- If a site reuses one container for all chapters (no per-chapter wrapper), the
  "one match = one chapter" rule will see a single chapter. That is a shape the
  selector cannot express; report it rather than guessing.
