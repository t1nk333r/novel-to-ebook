# Plan 010: Make Block Element actions remove matching elements

> **Executor instructions**: Fix only the block action semantics and update
> `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/lib/browser.ts src/app/projects/schema.ts ui/src/app/projects/view/components/browser-actions-input.tsx tests`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `5b03d47`, 2026-08-30

## Reconciliation 2026-08-31

This plan was marked DONE in error and has been **reopened as TODO**. The finding
is unchanged on the working tree: `src/lib/browser.ts:192-197` still resolves the
selector with `document.querySelector` and calls `el?.click()` inside
`if (type === "block")`. Neither done criterion holds — block does not remove, and
a single `querySelector` cannot remove multiple matches.

The current-state excerpts below are still accurate. Use the removal semantics
already proven in `src/app/projects/routes.ts:375-384`, which iterates
`document.querySelectorAll(selector)` and calls `el.remove()` on each match.

## Why this matters

The editor labels the action “Block Element,” but execution clicks the matching
element. This can navigate or mutate the remote page instead of removing an
obstruction before snapshot/TOC parsing.

## Current state

- `browser-actions-input.tsx:87` exposes `Block Element`.
- `src/lib/browser.ts:192-196` selects an anchor and calls `click()`.
- Snapshot `blockList` already establishes removal semantics at
  `src/app/projects/routes.ts:377-385`.

## Commands you will need

`pnpm test -- browser-actions` and `pnpm check` must pass.

## Scope

**In scope**: block action implementation and tests.

**Out of scope**: redesigning the action editor or other action semantics.

## Steps

1. Add a page-double test proving block removes all matching nodes and does not
   dispatch a click; include invalid/no-match selector behavior.
2. Implement removal with `querySelectorAll(selector).forEach(remove)` and a clear
   invalid-selector error consistent with other actions.
3. Verify other click/input/scroll/wait tests remain unchanged.

## Done criteria

- [ ] Block removes rather than clicks.
- [ ] Multiple matches are removed.
- [ ] `pnpm check` passes.

## STOP conditions

Stop if persisted project data uses `block` to mean click; report the serialized
shape and migration implication.

## Maintenance notes

Keep one semantic meaning for both action-based blocking and snapshot block lists.
