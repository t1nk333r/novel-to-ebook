# Plan 017: Refresh cached books conditionally

> **Executor instructions**: Preserve offline-first behavior, use HTTP validators,
> and update `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/app/library/routes.ts src/app/library/schema.ts ui/src/hooks/use-offline.ts ui/src/lib/db.ts tests`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: perf
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

Opening a cached book always starts a full download just to compare file size.
This wastes bandwidth/server I/O and leaves an unhandled rejection in the exact
offline case the cache is intended to support.

## Current state

- `ui/src/hooks/use-offline.ts:113-125` starts `fetchBook()` before returning cache.
- The cached branch attaches `.then()` without `.catch()`.
- `src/app/library/routes.ts:84-90` sends the file without ETag/Last-Modified or
  conditional request handling.

## Commands you will need

`pnpm test -- book-cache` and `pnpm check` must pass.

## Scope

**In scope**: stable ETag/Last-Modified metadata, conditional GET/HEAD behavior,
IndexedDB validator storage/version migration, offline refresh handling.

**Out of scope**: cache eviction UI, storage quotas, service-worker redesign.

## Steps

1. Add server tests for validator headers, matching conditional request (304),
   changed file (200), and PDF/EPUB content types.
2. Store file plus validator metadata in IndexedDB using a versioned migration.
3. Return cache immediately, perform a small conditional refresh, replace/open
   only when changed, and catch offline background failures as nonfatal.
4. Ensure object URLs/readers are updated only through plan 015's generation
   boundary. **Verify**: `pnpm check`.

## Done criteria

- [ ] Unchanged cached open transfers no book body.
- [ ] Changed book refreshes and triggers the existing notification.
- [ ] Offline cached open has no unhandled rejection.
- [ ] Uncached offline open still reports a useful error.

## STOP conditions

Stop if server file identity cannot be derived without reading the entire file;
use stat size/mtime, not a full hash on every request.

## Maintenance notes

Validator semantics must remain aligned with scan file identity from plan 016.
