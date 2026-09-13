# 033 — Auto-selector for the whole-book flow, and Arabic/RTL support

- **Status**: IN PROGRESS (2026-09-13)
- **Severity**: feature — the whole-book flow demands a CSS selector the operator has no way to know

## Part 1 — the app finds the selector itself

Today `POST /chapters/import-book` requires `selector`, and the UI blocks without
it. The operator is expected to hand-pick CSS for a site they may never have read.

Everything needed already exists, unconnected:

- `findContentSelector(html)` — a server-side heuristic, already used by the
  snapshot route;
- `generateSelectors(html)` — Mistral (or Ollama/Gemini) turning page HTML into
  selectors, verified live this session (it independently produced
  `.cha-paragraph p`, which resolved to the same 1,257 words as the hand-picked
  `div.cha-content`);
- the validation method used by hand all session: extract with the candidate and
  count what came out.

**Design.** `selector` becomes optional. When it is absent the walk opens the
*first* chapter of the catalogue and:

1. asks `findContentSelector` (free, instant);
2. **validates** it — at least one match, and the extracted text must be a
   meaningful share of the page's own text rather than navigation;
3. on failure, asks the model (one call) and validates again;
4. reports the chosen selector and the measured numbers in the progress stream;
5. only then walks. If nothing validates, it stops and says so.

Validation is the point. A bad selector is not a small error: it is two thousand
chapters of menu links, or two thousand empty ones, found hours later. One page
load turns that into a clear failure. `maxChapters` makes a first run cheap to
abandon.

## Part 2 — Arabic (and other RTL languages)

Mostly one decision point: the EPUB. foliate-js takes direction from the book, and
the reader reads exported books, so getting the file right fixes reading too.

- **`language` is not settable.** `CreateProjectReqSchema` picks only title and
  author, so everything is created as `en`. Adds `language` to the create schema,
  route and UI.
- **RTL rendering.** `@epubkit/epub-gen-memory` supports a `css` option; for an
  RTL language the export injects `direction: rtl; text-align: right` plus an
  Arabic-capable font stack, and the chapter `lang` follows the project.
- **Arabic catalogue timestamps.** `cleanImportedTitle` strips English relative
  times because catalogue rows glue them to titles ("Part 1/2" + "7 years ago").
  Arabic serials do the same thing with Arabic words, and the same bug appears.
  Adds the Arabic forms (`منذ`/`قبل` + units, Arabic-Indic digits included).

**Known limit, stated rather than hidden:** the generator writes no
`page-progression-direction`, so an RTL book pages left-to-right in readers that
follow the spine. Text renders correctly (Unicode bidi handles each paragraph);
pagination direction would need an OPF patch, which means rewriting the zip —
including EPUB's `mimetype`-first-stored rule. Not worth the risk here; recorded
as follow-up.

## Evidence

- Scorer tests: a page whose body holds ~90% of the text passes; a nav-only
  selector scoring a few percent is rejected; a selector matching nothing is
  rejected.
- Arabic: `isRtl` across the language set; Arabic timestamp stripping; and a real
  export of an Arabic project, asserting `dc:language` and the RTL CSS inside the
  generated EPUB (unzipped and grepped, not assumed).
- Auto-selector end to end: a whole-book import with **no** selector supplied,
  against the WordPress serial, reporting the selector it chose and the word
  count it measured.
