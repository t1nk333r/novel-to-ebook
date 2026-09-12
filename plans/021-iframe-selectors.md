# Plan 021: Make the selector picker and extraction work inside iframes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5b03d47..HEAD -- src/app/projects/utils.ts src/app/projects/routes.ts src/app/projects/schema.ts src/lib/limits.ts ui/src/app/projects/view/components tests`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Working-tree note**: at the time of writing, `HEAD` is `5b03d47` and a large
> body of work is uncommitted in the working tree. The drift command above may
> report nothing while the files still differ from this commit. Verify the
> excerpts below against the **working tree**, not against the diff.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/019-selector-precision.md`, `plans/020-multi-select-content.md`
- **Category**: bug
- **Planned at**: commit `5b03d47`, 2026-09-01
- **Resolved**: 2026-09-12 — see "Resolution" below

## Resolution 2026-09-12

Frames are now part of the pick and extract chain.

**Step 2's coordinate question, answered by experiment** (single-level and nested
fixtures): `frameElement().boundingBox()` is **main-frame-absolute at any depth** —
an iframe positioned at (60,120) reported (60,120), and a nested one reported its
accumulated main-frame position (85,160). The element's box in main-frame space is
therefore `frameElement().boundingBox() + in-frame getBoundingClientRect()`, and
**no walking of the parent chain is needed**. The plan asked for this to be
verified rather than trusted; had it come out the other way, an offset chain would
have been required.

What landed:

- `framePath?: string[]` on both selectors shapes and on `POST /projects/extract`
  — the CSS selector of each `<iframe>` from the main frame down. Optional
  everywhere, so existing payloads and stored selectors keep working untouched.
- `MAX_FRAMES` (8) bounds the work; frames past it are skipped with a warning
  naming the count only.
- `collectFrameElements(page, ignoreDuplicates)` replaces the single
  `page.evaluate(extractElements, …)` in the snapshot route. Main-frame elements
  get `framePath: []` and their boxes unchanged; child-frame elements get their
  path and an offset box. A detached or navigating frame is skipped with the
  frame **origin** logged — one bad frame cannot fail a snapshot.
- `framePathOf(frame)` walks `parentFrame()` to build a path, and `resolveFrame(page, framePath)`
  walks it back down for extraction, throwing an `HTTPError` naming the segment
  when the page structure changed and the pick is stale.
- `tryExtractContent` reads its HTML from the resolved frame (the document title
  still comes from the main frame).
- The snapshot's auto-detection now tries each child frame when the main frame
  yields no selector, returning the frame's path alongside `contentSelector`.
- The picker carries the frame path through to the request; picking in a
  different frame starts a new selection rather than mixing two documents, since
  one `framePath` describes the frame all content selectors resolve in.

**Two deviations, both deliberate.** (1) The plan suggested reusing the exported
`getSelector` for the iframe descriptors by evaluating it in the parent frame;
that is not possible — `evaluate` serializes the function into the page where
module scope does not exist, and arguments must be serializable — so a
self-contained `iframe:nth-of-type(n)` descriptor is computed inside the parent
frame instead. (2) Only `tryExtractContent` was made frame-aware; `extractContent`
is dead code (no callers anywhere, recorded in `plans/020`'s reconciliation) and
touching it would add risk for no behaviour.

Verified: 7 tests in `tests/frame-selectors.test.ts` — schema (absent, empty,
valid, empty segment, over-limit), `resolveFrame` on doubles (main frame for an
absent/empty path, a child frame when a segment matches, an error naming the
segment when none does), and a **real-browser** case that collects elements from a
fixture page whose content sits in an iframe: the in-frame paragraph is offered
with `framePath: ["iframe:nth-of-type(1)"]` and a box offset into main-frame space
(60+5, 120+10), and that path resolves back to the frame that produced it.
Regression check through the running route: a frame-less public page still returns
its element tree (5 elements, every one with `framePath: []`) and extraction with a
selector is unchanged.

## Why this matters

Many novel sites render chapter text inside an `<iframe>`. Storvi's snapshot
**screenshot shows that text** — screenshots capture rendered pixels, frames
included — but the selector picker draws no boxes over it and no selector the
user writes can ever match it. The entire selection and extraction chain runs
against the main frame only, and `getCleanHTML` deletes iframes outright before
auto-detection even looks. The result is a page that visibly contains the chapter
and an editor that insists there is nothing there. Supporting frames turns a
class of sites from impossible into ordinary.

## Current state

Four independent places restrict the pipeline to the main frame.

### 1. Element enumeration — main frame only

`src/app/projects/utils.ts:17` declares `extractElements`, and its collection loop
at `utils.ts:98` is:

```ts
for (const tag of tags) {
  document.querySelectorAll(tag).forEach((el: any) => {
    const rect = el.getBoundingClientRect();
    const selector = getSelector(el, document);
    ...
```

`document` here is the frame the function was evaluated in. It is invoked once,
against the page's main frame, at `src/app/projects/routes.ts:400`:

```ts
const elements = await page.evaluate(
  extractElements,
  body.ignoreDuplicates,
);
```

Child-frame documents are never enumerated.

### 2. Clean HTML deletes iframes

`src/app/projects/utils.ts:155-170`:

```ts
export function getCleanHTML() {
  const tagsToRemove = [
    "script",
    "style",
    "svg",
    "noscript",
    "iframe",        // <-- utils.ts:161
    "video",
    ...
  ];
  tagsToRemove.forEach((tag) => {
    document.querySelectorAll(tag).forEach((el) => el.remove());
  });
```

Because the `iframe` element is removed at `utils.ts:161`, the HTML handed to
`findContentSelector` (`routes.ts:404`) can never contain frame content, so
auto-detection cannot suggest a selector for it.

### 3. and 4. Extraction reads the main frame document

`extractContent` (`utils.ts:200`) reads
`page.evaluate(() => document.body.outerHTML.trim())`, and `tryExtractContent`
(`utils.ts:525`) reads `page.evaluate(getCleanHTML)`. Both are main-frame only,
so even a correct in-frame selector would match nothing.

### Verified Puppeteer API (puppeteer-core 25.9.0, installed)

Confirmed present in
`node_modules/.pnpm/puppeteer-core@25.9.0_yauzl@2.10.0/node_modules/puppeteer-core/lib/types.d.ts`:

| API | Line | Signature |
|---|---|---|
| `Page.frames()` | 6078 | `abstract frames(): Frame[]` |
| `Frame.frameElement()` | 3276 | `frameElement(): Promise<HandleFor<HTMLIFrameElement> \| null>` |
| `Frame.parentFrame()` | 3590 | `abstract parentFrame(): Frame \| null` |
| `Frame.childFrames()` | 3594 | `abstract childFrames(): Frame[]` |
| `Frame.url()` | 3586 | `abstract url(): string` |
| `ElementHandle.boundingBox()` | 2701 | `boundingBox(): Promise<BoundingBox \| null>` |

Do not assume any API beyond these without checking that file.

### CRITICAL CONSTRAINT — `extractElements` is duplicated and page-serialized

`getSelector` exists twice: inline inside `extractElements`
(`utils.ts:56-94`) and as a module-level export (`utils.ts:255-291`). The inline
copy exists because `extractElements` is passed to `page.evaluate` and runs in the
browser, where **module scope does not exist**. Anything `extractElements` or
`getCleanHTML` needs must be declared inside them. Plan 019 covers this in detail;
respect it here too — do not hoist shared helpers out of these functions.

### Conventions to match

- New bounds go in `src/lib/limits.ts` via `readPositiveInteger(name, fallback)`
  and are documented in `.env.example`.
- Route errors use `HTTPError` from `src/lib/error.ts`.
- Logging is plain `console.*`; log frame **URL origin only**, never page content.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Install   | `pnpm install --frozen-lockfile` | exit 0              |
| Tests     | `pnpm test -- frame`             | all pass            |
| Typecheck | `pnpm typecheck`                 | exit 0, no errors   |
| Lint      | `pnpm lint`                      | exit 0 errors       |
| Aggregate | `pnpm check`                     | exit 0              |

## Design decisions (do not redesign these)

1. **Frame addressing.** A selector gains an optional `framePath: string[]` — the
   CSS selector of each `<iframe>` element from the main frame down to the target
   frame. Absent or empty means the main frame. Frame **URL** is deliberately not
   used: it changes between loads on sites with cache-busting query strings.
2. **Backward compatibility.** `framePath` is optional everywhere. Existing
   projects have no `framePath` and must continue to work with zero migration.
3. **Coordinates.** `ElementHandle.boundingBox()` is documented as returning a box
   relative to the **main frame**, which is exactly the space the UI overlay draws
   in (`screenshot-viewer.tsx` lines 243-246 draw `el.box` scaled by `scale`).
   Step 2 verifies this empirically rather than trusting it — if it turns out to
   be frame-relative, you must accumulate offsets up the parent chain.
4. **Cross-origin frames are in scope.** Puppeteer evaluates in cross-origin
   frames normally; same-origin policy does not constrain it. Bound the work with
   a frame limit instead of an origin check.

## Scope

**In scope**:
- `src/app/projects/utils.ts` — frame-aware enumeration and extraction
- `src/app/projects/routes.ts` — snapshot route element collection
- `src/app/projects/schema.ts` — optional `framePath`
- `src/lib/limits.ts` and `.env.example` — one new bound
- `ui/src/app/projects/view/components/custom-selector-modal.tsx` — carry
  `framePath` through with the selector
- `tests/frame-selectors.test.ts` (create)

**Out of scope**:
- Browser actions and the block list (`src/lib/browser.ts`) — they remain
  main-frame only. Making actions frame-aware is a separate change and is not
  required to select or extract content.
- `getSelector`'s algorithm — plan 019 owns it.
- Content assembly across multiple selectors — plan 020 owns it.
- Nested frames deeper than the limit set in step 1.
- Shadow DOM. It has the same class of problem and is explicitly deferred.

## Git workflow

- Branch: `advisor/021-iframe-selectors`
- Conventional commits, e.g. `feat: support iframe content selectors`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the frame bound and schema field

`src/lib/limits.ts`:

```ts
frames: readPositiveInteger("MAX_FRAMES", 8),
```

Add `MAX_FRAMES=8` to `.env.example`.

In `src/app/projects/schema.ts`, add an optional `framePath: z.string().array().max(limits.frames).optional()`
to both selectors shapes (the config shape near line 8 and
`extractRequestSelectors` near line 153). Optional, never required.

**Verify**: `pnpm typecheck` → exit 0. `grep -n 'MAX_FRAMES' .env.example` → match.

### Step 2: Prove the coordinate space before building on it

Write a throwaway script (do not commit it) that launches the browser via
`newBrowserPage` from `src/lib/browser.ts`, loads a local fixture page containing
a positioned `<iframe>` with a known element inside, and prints:

- `await (await frame.frameElement()).boundingBox()`
- the inner element's `getBoundingClientRect()` from inside the frame

Confirm whether adding the two gives the element's position in main-frame space,
or whether `boundingBox()` is already main-frame-absolute.

**Verify**: record the answer in your report. If `boundingBox()` is
main-frame-absolute, offsetting is `frameBox.x + innerRect.x`. If it is not, you
must accumulate `boundingBox()` up the `parentFrame()` chain — implement whichever
the experiment showed, and say which in your report.

### Step 3: Enumerate elements across frames

Add an exported async function to `src/app/projects/utils.ts`:

```ts
export async function collectFrameElements(page: Page, ignoreDuplicates: boolean)
```

It must:

- Iterate `page.frames()`, capped at `limits.frames`; log and skip the remainder
  with a `console.warn` naming the count only.
- For the main frame, call `frame.evaluate(extractElements, ignoreDuplicates)`
  unchanged and use the boxes as-is with `framePath: []`.
- For each child frame: resolve its `framePath` by walking `parentFrame()` up to
  the main frame, calling `frameElement()` at each level and computing that
  iframe element's own selector. Reuse the exported module-level `getSelector`
  by evaluating it in the parent frame against the iframe element.
- Offset each returned element's `box` by the frame origin per step 2's finding,
  and attach `framePath` to every element.
- Skip a frame whose `frameElement()` returns `null` (it is detached) or whose
  evaluate throws (it navigated mid-scan). Log the frame URL **origin only** and
  continue — one bad frame must not fail the whole snapshot.

Call it from `src/app/projects/routes.ts:400` in place of the direct
`page.evaluate(extractElements, ...)`.

The element payload keeps every existing field (`tag`, `selector`, `text`, `box`,
`attrs`) and gains only `framePath`. The UI hit test and overlay
(`screenshot-viewer.tsx` lines 103-115 and 243-246) then work unchanged.

**Verify**: `pnpm typecheck` → exit 0. `pnpm check` → exit 0.

### Step 4: Stop discarding iframes from auto-detection

Do **not** simply delete `"iframe"` from `tagsToRemove` at `utils.ts:161` —
removing iframe elements from the main-frame HTML is correct, since their content
is not in that document anyway.

Instead, in the snapshot route (`routes.ts:404`), after main-frame
`findContentSelector(html)` returns nothing, evaluate `getCleanHTML` in each child
frame (same `limits.frames` cap) and run `findContentSelector` on each result.
Return the first frame that yields a selector, with its `framePath` attached to
the response alongside `contentSelector`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 5: Resolve the frame during extraction

Add an exported helper to `src/app/projects/utils.ts`:

```ts
export async function resolveFrame(page: Page, framePath?: string[] | null)
```

Empty/absent `framePath` returns `page.mainFrame()`. Otherwise walk the path: at
each level, find the child frame whose `frameElement()` matches the selector at
that position. If no frame matches, throw an `HTTPError` whose message names the
failing path segment — the site's structure changed and the user must re-pick.

Use it in `extractContent` (`utils.ts:200`) and `tryExtractContent`
(`utils.ts:525`) so the HTML they read comes from the resolved frame rather than
`page`. Both currently call `page.evaluate(...)`; they must call
`frame.evaluate(...)` on the resolved frame.

**Verify**: `pnpm test -- frame` → step 6's tests pass.

### Step 6: Tests

Create `tests/frame-selectors.test.ts`. These must **not** launch a browser or
touch the network — test the pure pieces:

1. `framePath` schema: absent, empty array, one segment, over the limit → rejected.
2. Legacy selectors object with no `framePath` parses and normalizes to main frame.
3. `resolveFrame` with an empty/absent path returns the main frame — use a small
   fake `Page`/`Frame` object, not Puppeteer.
4. `resolveFrame` with an unmatched segment throws an error naming that segment.
5. Box offsetting: given a frame origin and an inner rect, the resulting box is
   the expected main-frame coordinate (pure arithmetic, per step 2's finding).

**Verify**: `pnpm test -- frame` → 5 tests pass. `pnpm check` → exit 0.

### Step 7: Carry `framePath` through the UI

In `custom-selector-modal.tsx`, the selected element already carries `framePath`
from the server. Persist it alongside the selector when submitting, so extraction
receives it. Do not add frame-picking UI — the user picks a visible element and
the frame is implied.

**Verify**: `pnpm lint` → 0 errors. `pnpm check` → exit 0.

## Test plan

- New file `tests/frame-selectors.test.ts`, 5 cases as listed in step 6.
- Structural pattern: `tests/clean-html.test.ts`.
- Case 2 is the backward-compatibility guard for existing projects.
- The existing test files and those added by plans 019 and 020 must all still pass.
- Verification: `pnpm test` → all pass, including 5 new tests.
- **Manual check the tests cannot cover** (report the result): run a real snapshot
  against a page with an iframe and confirm boxes are drawn over the frame's
  content and align with the screenshot. Note in your report that automated
  coverage stops at the pure functions.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; `tests/frame-selectors.test.ts` has 5 passing tests
- [ ] `grep -n 'collectFrameElements' src/app/projects/routes.ts` returns a match
- [ ] `grep -n 'page.evaluate(\s*extractElements' src/app/projects/routes.ts` returns no matches
- [ ] `grep -n 'frames' src/lib/limits.ts` returns a match
- [ ] `grep -n 'MAX_FRAMES' .env.example` returns a match
- [ ] A selectors object with no `framePath` still extracts (test case 2)
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 2 shows `boundingBox()` is neither main-frame-absolute nor resolvable by
  accumulating up `parentFrame()` — the overlay cannot be aligned and this plan's
  coordinate assumption is wrong.
- `frameElement()` returns `null` for **every** child frame on a real test page —
  frame identity cannot be established and the addressing scheme must change.
- Making frames work requires changing browser actions or the block list.
- The elements payload must lose or rename an existing field.
- You find yourself hoisting a helper out of `extractElements` or `getCleanHTML`
  to share it — re-read the CRITICAL CONSTRAINT; that breaks `page.evaluate`.
- `pnpm test` cannot run because Bun is not installed. Report it.

## Maintenance notes

- Browser actions and the block list are still main-frame only. A user who needs
  to dismiss an overlay *inside* a frame cannot. That is the most likely
  follow-up request; it is deliberately not in this plan.
- Shadow DOM has the identical structure of problem and would reuse the
  `framePath` idea as a `shadowPath`. Deferred.
- Frames are bounded by `MAX_FRAMES` (default 8). Ad-heavy pages routinely carry
  more; if users report missing content on such pages, raising the bound is the
  first thing to check.
- A reviewer should scrutinize step 3's error handling: a frame that navigates
  mid-scan must degrade to a skipped frame, never a failed snapshot.
