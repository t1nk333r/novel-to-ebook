# Plan 009: Make overlapping library rescans race-safe

> **Executor instructions**: Preserve latest-scan-wins semantics and update
> `plans/README.md` after deterministic overlap tests pass.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/app/library/context.ts src/app/library/utils.ts tests`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

Manual, scheduled, and post-export scans may overlap. Older invocations currently
operate on and clear a shared controller owned by a newer scan, losing cancellation
and allowing null dereferences or stale results.

## Current state

`src/app/library/context.ts:10-24` replaces a global controller, later reads the
global after awaits, and unconditionally sets it to null in every `finally`.

## Commands you will need

`pnpm test -- rescan` and `pnpm check` must exit 0.

## Scope

**In scope**: scan ownership/generation coordination and unit tests.

**Out of scope**: incremental caching and concurrency limits (plan 016).

## Steps

1. Add deferred-promise tests for A→B overlap, abort, stale completion, and error.
2. Capture each controller/generation locally. Only the active owner may publish
   results or clear the active slot; aborted scans must not log as ordinary errors.
3. Keep `getLibrary()` stable during a failed replacement scan.
   **Verify**: targeted test and `pnpm check` pass.

## Done criteria

- [ ] Latest started scan is the only one that can publish.
- [ ] An older `finally` cannot clear a newer controller.
- [ ] Abort is expected control flow, not an error log.

## STOP conditions

Stop if product intent is queue-all-scans rather than latest-scan-wins; that would
require a different scheduler contract.

## Maintenance notes

Plan 016 must retain this ownership invariant when adding the metadata cache.
