# Plan 015: Prevent stale reader loads from winning navigation

> **Executor instructions**: Add a generation/cancellation boundary and update
> `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- ui/src/app/reader/page.tsx ui/src/hooks/use-offline.ts ui/src/app/reader tests`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

A shared loading ref drops a new `bookKey` while an older fetch is pending. The
older completion can then open under the new URL and the skipped key is never
retried because changing a ref does not rerender.

## Current state

`ui/src/app/reader/page.tsx:154-171` starts `fetchBook`, guards with
`loadingRef.current`, and has no effect cleanup or generation check.

## Commands you will need

`pnpm test -- reader-load` and `pnpm check` must pass.

## Scope

**In scope**: reader load coordination, fetch abort signal propagation where
available, view cleanup, deferred-promise tests.

**Out of scope**: reader rendering features or changing Foliate internals.

## Steps

1. Extract/test a latest-generation load coordinator: A starts, B starts, A
   resolves/rejects, only B may install a view; unmount aborts pending work.
2. Replace the global loading flag with per-effect generation and cleanup.
   Close/remove only the view owned by the stale generation.
3. Handle fetch/open failures by clearing the loading overlay and showing a toast;
   do not leave unhandled promises. **Verify**: `pnpm check`.

## Done criteria

- [ ] Every key change starts or joins the correct load.
- [ ] Stale completion cannot mutate current reader state.
- [ ] Unmount closes current resources and listeners.

## STOP conditions

Stop if Foliate `close()` is not safe during `open()`; add generation discard first
and report the lifecycle limitation rather than racing close calls.

## Maintenance notes

Any future background book refresh must feed a new generation, never mutate the
active view from a detached promise.
