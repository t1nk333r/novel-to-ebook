# Plan 020: Let the picker select multiple content elements

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5b03d47..HEAD -- src/app/projects/utils.ts src/app/projects/schema.ts ui/src/app/projects/view/components tests`
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
- **Depends on**: `plans/019-selector-precision.md`
- **Category**: bug
- **Planned at**: commit `5b03d47`, 2026-09-01
- **Executed**: commit `04dfe0e`, 2026-09-12 — **retargeted**, see below

## Reconciliation 2026-09-12 — executed against a different function

This plan named `extractContent` (`src/app/projects/utils.ts`) as the defective
path. It is **dead code**: `extractContent`, `ExtractRequestSchema` and
`ExtractResponseSchema` have zero callers anywhere in the repository (verified
with a repo-wide search). The live selector path is

    POST /projects/extract  ->  tryExtractContent  ->  extractArticle(html, selector)

and `extractArticle` had the same defect the plan describes — `$(selector).html()`
returns only the first match's inner HTML. The work was done there instead; the
dead functions were left untouched (out of scope, and deleting them is a
separate decision). Steps 1–5 below were followed in substance with that
substitution, and the UI now closes the Add Chapter dialog while the picker is
open rather than stacking two modals (see `plans/025`).

## Why this matters

Chapter content is frequently split across several sibling blocks — an intro
paragraph, the body div, and a translator's note, or a page that breaks content
into two containers around an ad slot. The picker currently accepts exactly one
element, so the user must either pick a common ancestor (dragging in navigation
and ads) or lose part of the chapter. Worse, even a hand-written comma-group
selector silently fails today, because extraction reads only the first match.
Supporting an ordered list of selectors makes the common case expressible without
widening the selection.

## Current state

### Extraction reads only the first match

`src/app/projects/utils.ts:200-223`:

```ts
export async function extractContent(page: Page, url: string, selectors: any) {
  await assertSafeOutboundUrl(url);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const html = await page.evaluate(() => {
    return document.body.outerHTML.trim();
  });
  const $ = cheerio.load(html);
  const chapter = selectors.chapter
    ? $(selectors.chapter)
        .filter((_, i) => $(i).text().trim().length > 0)
        .first()
        .text()
        .trim()
    : null;
  const content = cleanHTML($(selectors.content).html() || "").replace(
    /src="\/\//g,
    'src="https://',
  );
  return { chapter, content, url, selectors };
}
```

`utils.ts:218` is the defect for this plan: cheerio's `.html()` returns the inner
HTML of the **first** element in the matched set and discards the rest. So
`$("div.a, div.b").html()` yields only `div.a`'s content. Any multi-match
selector — comma group or otherwise — silently loses data today.

### Schema currently allows only a single string

`src/app/projects/schema.ts:153-159`:

```ts
const extractRequestSelectors = z.object(
  {
    chapter: z.string().min(1, { message: "chapter selector is required" }),
    content: z.string().min(1, { message: "content selector is required" }),
  },
  { error: "selectors is required" },
);
```

There is a second, looser selectors shape at `src/app/projects/schema.ts:8-11`
(`chapter: z.string().nullish()`, `content: z.string().min(1)`) used for the
stored project config. Both must accept the new shape.

### The UI already has a multi-select pattern to copy

`ui/src/app/projects/view/components/custom-selector-modal.tsx`:

- Line 83 accumulates into a list for the block list:
  `setBlockList([...blockList, hoveredEl.selector]);`
- Line 109 assigns a single content selector:
  `onSelect={(el) => setSelector(el.selector)}`

The block-list flow in this same file is the exemplar for how multi-select should
feel. Match it.

`ui/src/app/projects/view/components/screenshot-viewer.tsx`:

- `onSelect?: ((el: any) => void) | null` (line 37)
- Hit test at lines 103-115 sorts smallest-area first and returns the top hit.
- A single `selectedEl` is rendered as a highlight rect at lines 257+.
- `elements` overlay rects are drawn at lines 243-246 from `el.box`.

### Conventions to match

- Zod schemas live in `src/app/projects/schema.ts`; routes validate with
  `c.req.valid(...)`. Errors use `HTTPError` from `src/lib/error.ts`.
- Bounded inputs come from `src/lib/limits.ts`, which reads env vars through
  `readPositiveInteger(name, fallback)`. Existing example:
  `blockSelectors: readPositiveInteger("MAX_BLOCK_SELECTORS", 100)`.
- Every new limit must also be added to `.env.example`, which lists each
  `MAX_*` var with its default.
- UI components are function components with hooks, 2-space indent, double quotes.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Install   | `pnpm install --frozen-lockfile` | exit 0              |
| Tests     | `pnpm test -- content-selectors` | all pass            |
| Typecheck | `pnpm typecheck`                 | exit 0, no errors   |
| Lint      | `pnpm lint`                      | exit 0 errors       |
| Aggregate | `pnpm check`                     | exit 0              |

## Scope

**In scope**:
- `src/app/projects/utils.ts` — `extractContent` content assembly only
- `src/app/projects/schema.ts` — both selectors shapes
- `src/lib/limits.ts` — one new bound
- `.env.example` — document the new bound
- `ui/src/app/projects/view/components/custom-selector-modal.tsx`
- `ui/src/app/projects/view/components/screenshot-viewer.tsx`
- `tests/content-selectors.test.ts` (create)

**Out of scope**:
- `getSelector` / `extractElements` — plan 019 owns selector generation.
- `tryExtractContent` (`utils.ts:525`) — it takes a single optional `selector`
  for auto-detected content and is a different path. Leave it alone; a follow-up
  can unify them once this shape is proven.
- Iframe traversal — plan 021.
- The block list — it is already multi-select and works.
- Reordering selectors by drag — out of scope; document order is selection order.

## Git workflow

- Branch: `advisor/020-multi-select-content`
- Conventional commits, e.g. `feat: support multiple content selectors`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Accept an array in the schemas, backward-compatibly

In `src/app/projects/schema.ts`, change the `content` field in **both** selectors
shapes (lines 8-11 and 153-159) to accept either a single string or an array of
strings, normalizing to an array:

```ts
const contentSelectors = z
  .union([z.string().min(1), z.string().min(1).array().min(1)])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .refine((v) => v.length <= limits.contentSelectors, {
    message: "too many content selectors",
  });
```

Import `limits` — `schema.ts:2` already does (`import { limits } from "../../lib/limits";`).

Accepting a bare string is **required**, not optional: existing projects have a
string persisted in their config, and they must keep working without a migration.

Add to `src/lib/limits.ts`, matching the surrounding style:

```ts
contentSelectors: readPositiveInteger("MAX_CONTENT_SELECTORS", 20),
```

Add `MAX_CONTENT_SELECTORS=20` to `.env.example` next to `MAX_BLOCK_SELECTORS`.

**Verify**: `pnpm typecheck` → exit 0. Every consumer of `selectors.content` now
sees `string[]`; fix the resulting type errors in step 2.

### Step 2: Concatenate every matched block, in document order

Rewrite the content assembly in `extractContent` (`utils.ts:218-221`) so it maps
over the selector array, collects the outer HTML of **every** match for each
selector, joins them, and only then runs `cleanHTML`.

Requirements:

- Use `.map()` over the cheerio matched set, not `.html()`. `.html()` is the bug.
- Preserve **document order** across the union, and **de-duplicate**: if one
  selector's match contains another's, the inner one must not be emitted twice.
  Compare matched DOM nodes for containment before appending.
- An individual selector matching nothing is not an error — skip it. Only throw
  when the combined result is empty, matching the existing failure mode
  (`tryExtractContent` throws `new Error("Cannot extract content")`).
- Keep the existing `.replace(/src="\/\//g, 'src="https://')` protocol fix
  applied to the joined result.
- Log skipped selectors at `console.warn` with the selector string only — never
  page content. Logging in this repo is plain `console.*`; match that.

**Verify**: `pnpm test -- content-selectors` → the tests from step 3 pass.

### Step 3: Write the extraction tests

Create `tests/content-selectors.test.ts`. Test the content-assembly function
directly against HTML strings via cheerio — do **not** launch a browser; the
tests must not touch the network. If the assembly logic is currently inline
inside `extractContent`, extract it into a small exported pure function in
`src/app/projects/utils.ts` (e.g. `collectContentHtml($, selectors)`) so it can be
tested without Puppeteer, and have `extractContent` call it.

Cases:

1. Single selector, single match → same output as before this plan (regression).
2. Single selector matching three siblings → all three appear, in document order.
3. Two selectors → union in document order, not selector order.
4. Overlapping selectors where one match contains the other → inner content
   appears exactly once.
5. One selector matches nothing → its absence is skipped, others still returned.
6. All selectors match nothing → empty result, so the caller throws.
7. A legacy single-string selector value → normalizes to a one-element array and
   behaves as case 1.

**Verify**: `pnpm test -- content-selectors` → 7 tests pass.

### Step 4: Multi-select in the picker UI

In `screenshot-viewer.tsx`, allow a set of selected elements instead of one:

- Accept a `selectedElements?: any[]` prop alongside the existing single-selection
  rendering, and render a highlight rect for each, reusing the existing rect
  rendering at lines 257+.
- `onSelect` keeps its `(el) => void` signature. Toggling is the parent's job —
  do not change the hit test at lines 103-115.

In `custom-selector-modal.tsx`:

- Replace the single `selector` state with an ordered array.
- `onSelect` (line 109) toggles: if the clicked element's selector is already in
  the array, remove it; otherwise append. This mirrors the block-list flow at
  line 83 in the same file.
- Render the chosen selectors as a removable list, and keep a "clear all" action.
- Submit the array to the API.

**Verify**: `pnpm lint` → 0 errors. `pnpm typecheck` → exit 0.

### Step 5: Full gate

**Verify**: `pnpm check` → exit 0.

## Test plan

- New file `tests/content-selectors.test.ts`, 7 cases as listed in step 3.
- Structural pattern: `tests/clean-html.test.ts` (pure function over HTML strings).
- Case 1 and case 7 are the regression guards for existing single-selector
  projects — they must pass before and after.
- The existing test files must continue to pass unchanged.
- Verification: `pnpm test` → all pass, including 7 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; `tests/content-selectors.test.ts` has 7 passing tests
- [ ] `grep -n '\$(selectors.content).html()' src/app/projects/utils.ts` returns no matches
- [ ] `grep -n 'contentSelectors' src/lib/limits.ts` returns a match
- [ ] `grep -n 'MAX_CONTENT_SELECTORS' .env.example` returns a match
- [ ] A project whose stored config has a plain string `content` selector still
      extracts correctly (covered by test case 7)
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `utils.ts:218` no longer reads `$(selectors.content).html()`.
- Accepting an array would require a database migration of stored project
  configs — it should not, because the union type accepts the legacy string.
  If you find a code path that cannot accept the string form, report it.
- The UI change requires modifying the `elements` payload shape from the server.
- `tryExtractContent` turns out to share the content-assembly path you are
  changing (it should not; it takes a single `selector`). If it does, stop —
  the scope boundary in this plan is wrong.
- `pnpm test` cannot run because Bun is not installed. Report it.

## Maintenance notes

- Plan 021 (iframes) adds a frame qualifier to selectors. It is written to build
  on the array shape introduced here, so land this first.
- `tryExtractContent`'s single-`selector` parameter is now inconsistent with the
  array used by `extractContent`. That inconsistency is deliberate and deferred;
  unify only when there is a reason to touch both.
- A reviewer should focus on step 2's de-duplication: the subtle failure is
  emitting nested content twice, which shows up as duplicated paragraphs in the
  exported EPUB rather than as a test failure.
