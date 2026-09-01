# Plan 016: Make library scanning incremental and concurrency-bounded

> **Executor instructions**: Preserve scan results and latest-scan ownership,
> benchmark with fixtures, and update `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/app/library src/scheduler.ts tests`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/009-rescan-race.md`
- **Category**: perf
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

Every five-minute scan reparses every unchanged EPUB/PDF, rerenders covers,
recomputes blur hashes, starts unbounded file work, and repeatedly scans the full
result for directory metadata. Cost grows poorly with library size.

## Current state

- `src/scheduler.ts:5` runs a full scan every five minutes.
- `src/app/library/utils.ts:32-53` nests unbounded `Promise.all` calls.
- `utils.ts:79-124` reparses/reprocesses every supported file.
- `utils.ts:151-166` uses repeated find/filter/sort directory passes.

## Commands you will need

`pnpm test -- library-scan`, `pnpm check`, and a deterministic benchmark fixture
must pass; a second unchanged scan must perform zero parser/image calls.

## Scope

**In scope**: metadata cache keyed by canonical path and file identity, bounded
worker pool, one-pass directory aggregation, deletion invalidation, tests.

**Out of scope**: persistent cache database, filesystem watchers, remote libraries.

## Steps

1. Add fixtures/instrumented parser counters for unchanged, modified, added,
   removed, abort, and nested-directory cases.
2. Separate enumeration from file enrichment. Cache successful file enrichment by
   canonical path plus size/mtime; never cache failures indefinitely.
3. Process enrichment through a configurable small concurrency pool respecting
   abort. Build parent-child metadata maps in linear passes.
4. Evict missing/changed entries only after the active scan successfully publishes.
   **Verify**: second-scan counters are zero and `pnpm check` passes.

## Done criteria

- [ ] Unchanged scans do not reparse books or regenerate covers.
- [ ] File work never exceeds configured concurrency.
- [ ] Add/change/remove and nested directory results match a cold scan.
- [ ] Abort cannot publish partial cache/library state.

## STOP conditions

Stop if Bun's directory entry timestamps are insufficiently stable; use explicit
`stat` size/mtime rather than content hashing every unchanged file.

## Maintenance notes

Cache identity intentionally lives in memory; process restart performs one cold
scan and avoids a cache schema/migration burden.
