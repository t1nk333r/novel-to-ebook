# Plan 019: Generate content selectors that match exactly the intended element

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5b03d47..HEAD -- src/app/projects/utils.ts tests`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Working-tree note**: at the time of writing, `HEAD` is `5b03d47` and a large
> body of work is uncommitted in the working tree. The drift command above may
> therefore report nothing while the files still differ from this commit.
> Verify the excerpts below against the **working tree**, not against the diff.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `5b03d47`, 2026-09-01

## Why this matters

When a user picks an element in the snapshot selector, Storvi generates a CSS
selector for it. That selector is routinely **broader than the element the user
clicked**: it uses descendant combinators and adds positional disambiguation only
to the deepest segment, so a click on one paragraph can produce a selector that
matches every paragraph on the page. Extraction then pulls in navigation, ads, and
sibling sections, or — because `extractContent` reads only the first match — pulls
the wrong block entirely. Making the generated selector resolve to exactly the
clicked element is the difference between the picker being usable and being a
starting point the user has to hand-edit every time.

## Current state

Files:

- `src/app/projects/utils.ts` — selector generation and page extraction. Contains
  **two copies** of the same algorithm (see the critical constraint below).
- `tests/` — Bun tests. `tests/clean-html.test.ts` is the structural pattern to
  follow for a pure-function test over DOM-ish input.

### CRITICAL CONSTRAINT — the algorithm is duplicated on purpose

`getSelector` exists twice with identical bodies:

1. **Inline copy**, `src/app/projects/utils.ts:56-94`, nested inside
   `extractElements` (which starts at line 17).
2. **Module-level export**, `src/app/projects/utils.ts:255-291`, used by
   `findChapterTitle`.

The inline copy exists because `extractElements` is serialized into the browser by
`page.evaluate(extractElements, ...)` at `src/app/projects/routes.ts:400`. A
function passed to `page.evaluate` runs in the page context and **cannot reference
anything from Node module scope**. If you "dedupe" by making the inline copy call
the module-level `getSelector`, the picker breaks at runtime with a
`ReferenceError` inside the page, and no typecheck or unit test will catch it.

**You must apply the same change to BOTH copies.** Do not attempt to share them.

### The current algorithm (module-level copy, `utils.ts:255-291`)

```ts
export function getSelector(el: HTMLElement, doc: Document) {
  const parts = [];
  let current: HTMLElement | null = el;

  let depth = 0;
  while (current && current !== doc.body && depth < 10) {
    depth++;
    let seg = current.tagName.toLowerCase();
    if (current.id) {
      seg += `#${current.id}`;
      parts.unshift(seg);
      break;
    }
    const classes = Array.from(current.classList)
      .filter((c) => {
        return !c.match(/^\d/) && c.length < 24 && !c.match(/\d{6,}/);
      })
      .slice(0, 2)
      .join(".");
    if (classes) seg += `.${classes}`;
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (c) =>
            c.tagName === current?.tagName &&
            (!current.classList.length ||
              c.classList.contains(current.classList[0]!)),
        )
      : [];
    if (siblings.length > 1 && parts.length === 0) {
      seg += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(seg);
    current = current.parentElement;
  }

  // return parts.join(" > ");
  return parts.join(" ");
}
```

The inline copy at `utils.ts:56-94` is the same code, ending with the same
commented-out line at `utils.ts:93` and `return parts.join(" ")` at `utils.ts:94`.

### Why it over-matches — four concrete defects

1. **Descendant combinator** (`utils.ts:94`, `utils.ts:291`). `parts.join(" ")`
   produces `div.article p`, which matches every `p` at any depth under
   `div.article`. The author's own commented-out `parts.join(" > ")` on
   `utils.ts:93` / `utils.ts:290` is the child combinator that would scope it.
2. **Positional disambiguation only on the deepest segment.** The condition
   `siblings.length > 1 && parts.length === 0` is true only on the first
   iteration, because `parts` is non-empty on every later one. Every ancestor
   segment is therefore emitted with no `:nth-of-type`, so an ancestor like
   `div.chapter` that appears five times stays ambiguous.
3. **No uniqueness check.** The function never calls `doc.querySelectorAll(sel)`
   to confirm the result resolves back to `el`. It returns whatever it built.
4. **Class list truncated to two** (`.slice(0, 2)`). Two classes are often not
   distinguishing on utility-class-heavy sites.

### Conventions to match

- Plain exported functions, no classes, 2-space indent, double quotes.
- Tests are Bun tests: `import { describe, expect, test } from "bun:test";` — see
  `tests/clean-html.test.ts` for the shape.
- The repo has no DOM test helper. Use `jsdom` (already a production dependency,
  imported as `import { JSDOM } from "jsdom"` — see `src/app/projects/utils.ts`)
  to build fixture documents in tests.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Install   | `pnpm install --frozen-lockfile` | exit 0              |
| Tests     | `pnpm test -- selector`          | all pass            |
| Typecheck | `pnpm typecheck`                 | exit 0, no errors   |
| Lint      | `pnpm lint`                      | exit 0 (warnings allowed, 0 errors) |
| Aggregate | `pnpm check`                     | exit 0              |

`pnpm check` runs tests, both typechecks, lint, and the production UI build.
Bun 1.4+ must be installed; `pnpm test` is `bun test`.

## Scope

**In scope** (the only files you should modify):
- `src/app/projects/utils.ts` — both copies of the selector algorithm
- `tests/selector.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `src/app/projects/routes.ts` — the snapshot route needs no change; it already
  passes `extractElements` through `page.evaluate`.
- `ui/src/app/projects/view/components/screenshot-viewer.tsx` and
  `custom-selector-modal.tsx` — the UI consumes `el.selector` as an opaque
  string and is unaffected by making that string more precise.
- `extractContent` / `tryExtractContent` — extraction semantics are plan 020's
  subject. Do not change how matches are combined here.
- Iframe traversal — plan 021.

## Git workflow

- Branch: `advisor/019-selector-precision`
- Commit per step; message style is conventional commits — recent examples from
  `git log`: `fix: err scanfile & reader fix`, `feat: add rescan button`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add failing tests for selector precision

Create `tests/selector.test.ts`. Import the module-level `getSelector` from
`../src/app/projects/utils` and build documents with `JSDOM`.

Cover these cases, each asserting **`doc.querySelectorAll(selector).length === 1`
and `doc.querySelector(selector) === target`**:

1. Element with an `id` → selector uses the id and is unique.
2. One `p` among five sibling `p`s inside `div.article` → must not match the
   other four.
3. Target nested under an ancestor `div.chapter` that occurs three times in the
   document → the ancestor segment must be disambiguated, not left bare.
4. Element whose only classes are utility classes shared by many elements.
5. Element directly under `body`.
6. A document where the target is genuinely indistinguishable from a sibling
   (identical tag, classes, and position under duplicated parents) → the function
   must still return a selector and must not throw; assert it returns a non-empty
   string.

**Verify**: `pnpm test -- selector` → tests run and **fail** on cases 2, 3, and 4.
Record which fail. If case 2 passes before any change, STOP and report — the
algorithm is not what this plan describes.

### Step 2: Make the algorithm resolve to exactly one element

Rewrite the body of the module-level `getSelector` (`utils.ts:255-291`) so that:

- Segments are joined with the **child combinator** `" > "`, not `" "`.
- `:nth-of-type(n)` is applied to **every** segment that has ambiguous siblings,
  not only the deepest — remove the `parts.length === 0` condition.
- Keep the existing class filter (`!/^\d/`, `length < 24`, `!/\d{6,}/`) but raise
  the cap from 2 to 3 classes.
- Keep the `id` early-break and the `depth < 10` bound unchanged.
- After building the selector, **verify it**: if
  `doc.querySelectorAll(sel).length !== 1 || doc.querySelector(sel) !== el`,
  continue walking further up the ancestor chain (still bounded by `depth < 10`)
  and re-test. If the bound is reached without uniqueness, return the best
  selector built so far rather than throwing.

Wrap the verification in `try/catch` — `querySelectorAll` throws
`SyntaxError` on a malformed selector (a class name containing CSS-special
characters can produce one). On a throw, treat that candidate as non-unique and
keep walking. Never let a bad class name propagate an exception into
`page.evaluate`.

**Verify**: `pnpm test -- selector` → all cases from step 1 pass.

### Step 3: Apply the identical change to the inline copy

Replace the body of the nested `getSelector` inside `extractElements`
(`utils.ts:56-94`) with the same implementation.

Re-read the CRITICAL CONSTRAINT above before doing this. The inline copy must
remain fully self-contained: no imports, no references to module-scope
identifiers, no helper functions declared outside `extractElements`. Everything
it needs must be declared inside `extractElements` itself.

**Verify**: `grep -c 'parts.join(" > ")' src/app/projects/utils.ts` → `2`.
Then `grep -n 'parts.join(" ")' src/app/projects/utils.ts` → no matches
(both old joins are gone, including the commented-out lines if you removed them).

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Confirm no regression in the picker's payload shape

The elements array returned by `extractElements` must keep exactly the same
fields: `tag`, `selector`, `text`, `box: {x,y,w,h}`, `attrs: {id,class,href,src}`.
The UI reads all of them.

**Verify**: `grep -n "tag:\|selector,\|text,\|box: {\|attrs: {" src/app/projects/utils.ts | head` →
the object literal in `extractElements` is unchanged apart from the selector value.

**Verify**: `pnpm check` → exit 0.

## Test plan

- New file `tests/selector.test.ts`, six cases as listed in step 1, each asserting
  uniqueness (`querySelectorAll(...).length === 1`) and identity
  (`querySelector(...) === target`).
- Structural pattern: `tests/clean-html.test.ts`.
- The existing three test files must continue to pass unchanged.
- Verification: `pnpm test` → all pass, including 6 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; `tests/selector.test.ts` exists with 6 passing tests
- [ ] `grep -c 'parts.join(" > ")' src/app/projects/utils.ts` returns `2`
- [ ] `grep -n 'parts.join(" ")' src/app/projects/utils.ts` returns no matches
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `utils.ts:56-94` or `utils.ts:255-291` does not match the excerpts
  above.
- Step 1's case 2 passes before you change anything.
- You conclude the two copies should be merged into one shared function — read
  the CRITICAL CONSTRAINT again; if you still believe it, stop and report rather
  than doing it.
- Making selectors unique requires changing the `elements` payload shape that
  the UI consumes.
- `pnpm test` cannot run because Bun is not installed. Report this; do not
  substitute a different runner.

## Maintenance notes

- Plan 020 (multi-select) and plan 021 (iframes) both build on this function.
  Land this one first: a more precise selector is a prerequisite for combining
  several of them into a selector group.
- The two-copy duplication is a genuine trap. If anyone later adds a shared
  helper for selector building, it must be inlined into `extractElements` by a
  build step or duplicated again — `page.evaluate` will not resolve module scope.
- A reviewer should check that the inline copy and the module-level copy are
  still behaviorally identical, since only the module-level one is unit-tested.
  Consider a test that asserts the two function sources are equivalent if this
  drifts again.
