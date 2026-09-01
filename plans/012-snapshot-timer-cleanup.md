# Plan 012: Always stop snapshot screenshot timers

> **Executor instructions**: Test error and abort lifecycle paths and update
> `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/app/projects/routes.ts tests`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

Snapshot actions start an async screenshot interval that is cleared only on the
success path. Action or stream failures leave work running against a closed page,
creating repeated exceptions and CPU usage.

## Current state

- `src/app/projects/routes.ts:375` declares the timer inside `try`.
- `routes.ts:391` starts an async callback every 250 ms.
- `routes.ts:396` clears it only after successful actions.
- `finally` at line 422 can close the page but cannot reach the timer.

## Commands you will need

`pnpm test -- snapshot-lifecycle` and `pnpm check` must pass.

## Scope

**In scope**: screenshot scheduling/cleanup and lifecycle tests.

**Out of scope**: screenshot UI, image format, workload cap values from plan 008.

## Steps

1. Extract a small non-overlapping periodic runner or inject timers so fake-time
   tests can assert stop on success, action error, SSE abort, and page error.
2. Declare cleanup ownership outside `try`; stop it in `finally` before closing
   the page. Never begin a new screenshot while the previous one is pending.
3. Ensure final-result screenshot remains ordered after action screenshots.
   **Verify**: `pnpm check`.

## Done criteria

- [ ] Every handler exit clears/stops periodic screenshot work.
- [ ] Async screenshots never overlap.
- [ ] No callback uses a closed page.

## STOP conditions

Stop if stream abort cannot be observed by the current Hono stream API; report the
available signal rather than polling indefinitely.

## Maintenance notes

Timer handles belong to request scope and must always be cleaned before browser
resources.
