# Plan 025: Finish the picker → save flow (stacked Radix dialogs)

> **Executor instructions**: Read this whole file first. Reproduce before you
> change anything — the fix depends on what the reproduction actually shows.
> When done, update the status row for this plan in `plans/README.md` unless a
> reviewer told you they maintain the index.
>
> **Drift check**: `git diff --stat 04dfe0e..HEAD -- ui/src/app/projects/view/components ui/src/components/ui/dialog.tsx`

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED
- **Depends on**: `plans/020-multi-select-content.md` (landed)
- **Category**: bug
- **Planned at**: commit `04dfe0e`, 2026-09-12
- **Resolved**: 2026-09-12 — see "Resolution" below

## Resolution 2026-09-12

**The Save button was never dead.** It looked dead because client-side validation
failed silently and `handleSubmit` therefore never ran the submit handler.

The Add Chapter form's zod schema required `selector: z.string()`, but the picker
submits an ordered **array** of picked blocks (plan 020). Every picked selection
was rejected by the resolver, and the form had no `onInvalid` handler, so nothing
happened at all: no request, no error, no toast. It worked only when the selector
was hand-typed as a string, which is why the fresh-flow test passed and every
picker test failed.

Fixed by:

- widening the form schema to `z.union([z.string(), z.string().array()]).nullish()`,
  mirroring the API contract;
- adding an `onInvalid` handler that names the offending field (the missing
  feedback is what made this expensive to find);
- making the URL input controlled, so it repopulates when the dialog remounts
  after a pick instead of showing an empty box over a populated form;
- removing a `useEffect([open])` that wiped the URL on every reopen, and moving
  the reset to the create-success path instead.

Two earlier changes in the same area also stand, but for the separate defect they
address: the picker unmounts while closed, and the Add Chapter dialog closes
instead of stacking under it — the closed picker's Radix layer really did stay
mounted with `pointer-events: auto` and made the dialog below unclickable.

Proven end to end afterwards: pick `h1` + `p:nth-of-type(2)` in the picker, save,
and the created chapter contains both blocks
(`<h1>Example Domain</h1>` and the `<p>` link paragraph).

**A wrong hypothesis is recorded here so it is not repeated.** This plan
originally described the dialog's DOM as orphaned from React because native click
and submit events fired without reaching React handlers. That was wrong: the
Close button worked the whole time, and once `onInvalid` existed the toast proved
the submit path was reaching React and failing validation. The lesson is the same
one the repo keeps relearning — the absence of feedback was mistaken for dead
code.

## Why this matters

Picking a content selector is the primary way to add a chapter from a link. The
picker is a Radix `Dialog` opened *on top of* the Add Chapter `Dialog`, and that
stacking leaves the lower dialog unusable: its DOM stays on screen, but clicking
Save does nothing — no request, no error, no toast. The user's only recovery is
a page reload, which discards the URL and selector they just picked.

Two mitigations already landed in `04dfe0e` (the picker unmounts while closed;
the Add Chapter dialog closes while the picker is open instead of stacking), and
they removed the symptom I could measure most directly — a permanently mounted
`data-state="closed"` layer with `pointer-events: auto` that kept everything
below it inert. **Saving immediately after a pick is still not confirmed
working**, which is why this plan exists.

## Current state

What was observed, in a headless Chromium against a production build
(`pnpm build`, server on `:3012`, project view → Add → Link → Pick → click two
elements → Select 2 blocks → Save):

1. The pick is fine: the form field shows `h1, p:nth-of-type(2)`, the button
   reads "Select 2 blocks", `POST /projects/snapshot` streamed the screenshot.
2. After the pick exactly one dialog node remains (`Add Chapter`), connected,
   `pointer-events: auto`, with a single Save button.
3. Clicking Save with a real mouse click fires a native `click` **and** a native
   `submit` on the form (both were counted by listeners injected into the page),
   and the URL input still holds `https://example.com` — but **no XHR is issued**
   and no toast appears.
4. Clicking that dialog's own Close button does not close it either.
5. Without the picker, the identical flow works: `POST /projects/extract` →
   `POST /projects/{id}/chapters` → the chapter appears with content from every
   selected block. Close works.
6. The same dead-dialog behaviour reproduces on the **deployed pre-change build**
   (`:3000`, commit `a505f3a`-era UI), so it is not introduced by plan 020.

The pattern in 3 and 4 — native events fire, React handlers never do — points at
the dialog's DOM node no longer belonging to the mounted React tree, rather than
at pointer interception (a JS `.click()` bypasses `pointer-events` anyway).
That is consistent with a Radix `Dialog`/`Presence` + portal interaction, since
the failure only appears after a second dialog has been mounted over the first.
It has **not** been proven; do not treat it as the diagnosis.

Relevant files:

- `ui/src/app/projects/view/components/add-chapter-modal.tsx` — the form
  ("Add", type grid, URL, Custom Selector, Save, `onSubmit`, Pick button).
- `ui/src/app/projects/view/components/custom-selector-modal.tsx` — the picker;
  `customSelectorModal` disclosure; returns early when closed.
- `ui/src/components/ui/dialog.tsx` — generated shadcn wrapper. `DialogContent`
  carries `data-[state=closed]:animate-out data-[state=closed]:fade-out-0
  data-[state=closed]:zoom-out-95`; the built CSS does contain `@keyframes exit`
  and `animation: exit … 0.2s`, so a missing keyframe is *not* the cause.
- `ui/src/app/projects/view/page.tsx` — renders both modals under one provider.

## Commands you will need

```bash
export PATH="$HOME/.local/share/mise/installs/bun/1.4.0/bin:$PATH"
pnpm install --frozen-lockfile --ignore-scripts   # --ignore-scripts is required
pnpm build                                        # the server serves ui/dist
```

| Purpose | Command | Expected |
|---|---|---|
| Repro server | `HOST=127.0.0.1 PORT=3012 DATABASE_URL=/tmp/picker.sqlite DATA_PATH=./data bun run src/index.ts` | `Listening on` |
| Seed a project | `curl -s -X POST -H 'Content-Type: application/json' -d '{"title":"Picker","author":"qa","language":"en"}' http://127.0.0.1:3012/api/projects` | an `id` |
| Unit tests | `pnpm test` | all pass |
| Typecheck / lint / build | `pnpm typecheck`, `pnpm lint`, `pnpm build` | 0 errors |

The snapshot route needs a real Chromium; `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`
works on this machine. `https://example.com` is a stable, policy-allowed target.

## Scope

**In scope**: `ui/src/app/projects/view/components/add-chapter-modal.tsx`,
`ui/src/app/projects/view/components/custom-selector-modal.tsx`, and — only if
the evidence requires it — `ui/src/components/ui/dialog.tsx`.

**Out of scope**: the extraction pipeline and selector schema (plan 020, done);
any other dialog (`fontDecryptMapModal`, `importTOCModal`) unless step 2 shows
they share the defect; changes to the server.

## Steps

### Step 1: Reproduce and localise

Build, start the server, seed a project, and repeat the sequence in "Current
state" with a browser you can drive. Before changing anything, record:

- whether the failing dialog's node is still in the React tree — the surest test
  is whether *any* handler in it runs (the Close button is the cheapest probe);
- how many nodes `document.querySelectorAll('[role="dialog"]')` returns, and
  each one's `data-state` and parent;
- whether the same dead-dialog state appears when the picker is opened from a
  *live* page with the Add Chapter dialog never opened at all (if the picker is
  reachable standalone) — this separates "second dialog" from "the picker".

**Verify**: a written reproduction with the three observations above.

### Step 2: Check whether other stacked dialogs share it

`importTOCModal` is opened from the Add Chapter dialog's "Multi Link" button
immediately after `addChapterModal.setOpen(false)`. Run the same liveness probe
there. If it also leaves a dead dialog, fix the *pattern* rather than one
component: the defect is then in how this app stacks modals, not in the picker.

**Verify**: the same probe repeated for the Multi Link path, with the result
recorded.

### Step 3: Fix

Choose based on what step 1 shows; do not apply all three.

- If the lower dialog's node is out of the React tree: stop relying on the
  stacked mount. Keep the "one modal at a time" rule already introduced (the
  picker closes the form dialog and reopens it with the selection), and make it
  the only path — the Add Chapter dialog must not be rendered while the picker
  is open. Mount the picker only when open (already done).
- If instead the dialog stays in the tree and only pointer/scroll locking is
  wrong: neutralise Radix's lock for the lower dialog while the picker is open,
  or give the picker its own non-modal layer, and confirm the form dialog is
  interactive while the picker is up.
- If the failure survives both, disable the exit animation on `DialogContent`
  (`data-[state=closed]:animate-none`) or unmount dialog content without an exit
  animation. That is a real option only if measured — it trades the animation
  for determinism, and if you take it, say so plainly in your report.

Keep the form state across the picker round trip: `form.setValue("selector", …)`
must survive, and the URL must still be there when the dialog reopens (it does
today because the component itself stays mounted).

**Verify**: after the pick, the Add Chapter dialog is interactive — the Close
button closes it, and Save issues `POST /projects/extract` followed by
`POST /projects/{id}/chapters`.

### Step 4: Prove it end to end

Repeat the full flow on a fresh page: Add → Link → URL → Pick → select two
elements on the screenshot → "Select 2 blocks" → Save. Then confirm from the API
that exactly one chapter exists whose content contains text from **both**
selected blocks.

**Verify**: `curl -s http://127.0.0.1:3012/api/projects/<id>/chapters | jq -r '.[].content'`
shows both blocks, and the browser issued both POSTs.

### Step 5: Gates

**Verify**: `pnpm test` → all pass; `pnpm typecheck` → exit 0; `pnpm lint` → 0
errors; `pnpm build` → exit 0.

## Done criteria

- [ ] Saving after a pick works, proven by both POSTs in the network log and the
      chapter content containing both selected blocks.
- [ ] The Add Chapter dialog remains interactive after a pick (Close works).
- [ ] The Multi Link path checked and either fixed or explicitly recorded as
      unaffected.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` all clean.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- The defect cannot be reproduced on a fresh build — then the previous
  observation was an artifact of how the page was driven, and the honest outcome
  is "no change needed", with the reproduction attempt recorded.
- The fix would require changing the generated `ui/src/components/ui/dialog.tsx`
  in a way that affects every dialog in the app — that is a design decision for
  the operator, not a step in this plan.
- Two attempts fail. Report what the reproduction showed; a well-documented open
  defect is more useful than a speculative change.

## Maintenance notes

- The invariant worth keeping: this app opens modals **one at a time**. Any new
  "open B from A" flow must close A first (as `addChapter-modal` now does) or it
  risks the same dead-dialog state.
- If a future Radix or React upgrade is taken, re-run the reproduction in step 1
  — this plan exists because the interaction was not understood, and a version
  bump is the cheapest moment to find out whether it is fixed for free.
