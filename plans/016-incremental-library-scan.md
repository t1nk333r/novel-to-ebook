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
- **Resolved**: 2026-09-12 — see "Resolution" below

## Resolution 2026-09-12

The scan is now incremental and bounded. `src/app/library/utils.ts`:

- **Enumeration is separate from enrichment.** `readdir` produces entries; each
  book is enriched (EPUB parse, cover extract, `sharp` resize, blur hash) only
  when the memo misses.
- **The memo is keyed by absolute path and validated by size + mtime**, which is
  what the plan's STOP condition called for — never content-hashing an unchanged
  file. It holds the *compressed cover bytes* too, so `/library/cover.jpeg` keeps
  working without re-opening the book. It lives in memory on purpose: a restart
  pays one cold scan and there is no cache schema to migrate.
- **Failures are not memoized**, so a book that failed to parse is retried.
- **Concurrency is bounded** by `MAX_SCAN_CONCURRENCY` (default 4) through a new
  `mapWithConcurrency` helper, replacing the unbounded nested `Promise.all` that
  opened every book at once, and it aborts between items.
- **Directory rollup is one pass** building two maps, replacing a per-directory
  `find`/`filter`/`sort` over the whole result (O(n²) before). The cover choice
  is now deterministic (lowest key) — `readdir` order can change between scans,
  and a directory cover that flips on its own looks like a bug.
- **Eviction happens only after a scan runs to completion.** A superseded scan is
  aborted, and an aborted scan does not prune, so it cannot drop live entries
  from an incomplete view.

Also fixed while in the function: `parent` was built with
`dirname(relative).replaceAll(".", "")`, which folded a directory named `vol.1`
into `vol1` and mangled any name containing `..`. It now strips only the `"."`
that means "the scan root".

Evidence: 10 tests in `tests/library-scan.test.ts` drive the scan with an
injected enricher, so "did it reparse?" is a counter rather than a timing guess —
the second unchanged scan makes **zero** enrichment calls, a modified or added
file is parsed, a removed file drops out and is parsed again if it returns, a
failing parse is retried, peak concurrency stays within the limit, and an aborted
scan rejects without returning partial items. Live check against real EPUBs:
metadata titles parsed, `parent=series` for a nested book, the directory row
carrying its child's cover, covers served as 252-byte webp from cache, and a
rescan returning 204 with covers still served.

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
