# Plan 014: Serialize chapter order allocation

> **Executor instructions**: Establish a database invariant and update
> `plans/README.md` after migration and concurrency tests pass.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/db src/app/projects/chapters tests`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-verification-baseline.md`, `plans/013-chapter-update-fields.md`
- **Category**: migration
- **Planned at**: commit `5b03d47`, 2026-08-30

## Reconciliation 2026-08-31

This plan was marked DONE in error and has been **reopened as TODO**. Nothing in
it was implemented:

- `src/db/migrations/` still contains only `0001-init.ts` and `index.ts`; there is
  no forward migration and no `(projectId, index)` uniqueness. `0001-init.ts:48-52`
  still indexes `index` alone.
- `src/app/projects/chapters/routes.ts:40` still computes
  `(await getLastIndex(projectId)) + 1` outside any transaction, then inserts.
- `src/app/projects/chapters/repository.ts:27` still allocates `lastIndex` once
  before the import loop and increments it in memory.

**Correction (2026-09-01):** an earlier revision of this section claimed
`reorderChapters` was unchanged. That was wrong — it was written from a truncated
`grep` that showed only the `caseSql` builder. `reorderChapters`
(`repository.ts:87-104`) **already** wraps its updates in `db.transaction()`,
applies a `+1000000` offset before the CASE update to avoid transient collisions,
and validates that the supplied ids are exactly the project's chapter set.
Treat step 4 as **review-and-confirm**, not rewrite: verify that the existing
implementation is still correct once the unique `(projectId, index)` index exists,
and leave it alone if it is. Do not redo this work.

Three of the four done criteria remain unmet. Its dependency, plan 013, **is** genuinely
complete (`chapters/routes.ts:169` now validates with
`ChapterSchema.pick({ title: true, content: true }).partial()`), so this plan is
executable now.

Additional debris found in scope: `repository.ts:50` contains a stray
`console.log("test")`. Remove it as part of this work.

## Why this matters

Manual creation and imports read the maximum index separately from insertion.
Concurrent writers can select the same next value, and the database has no
project-scoped uniqueness invariant.

## Current state

- `chapters/routes.ts:34-40` performs `getLastIndex()+1`, then inserts.
- `chapters/repository.ts:27-49` allocates once before an import loop.
- `0001-init.ts:46-52` indexes only `index`, without `(projectId,index)` uniqueness.
- Reorder uses one CASE update in `repository.ts:87-100`.

## Commands you will need

`pnpm test -- chapter-order`, migration tests, and `pnpm check` must pass.

## Scope

**In scope**: new forward migration, duplicate repair policy, transactional
allocation/insertion and reorder, concurrency tests.

**Out of scope**: fractional ordering, distributed databases, UI reorder redesign.

## Steps

1. Add tests with concurrent creates and create-vs-import, plus reorder under the
   uniqueness invariant.
2. Add a migration that deterministically normalizes existing chapter indices per
   project, then creates a unique `(projectId,index)` index.
3. Use a serialized SQLite transaction for allocate+insert. Make bulk import
   preserve ordered progress and recover cleanly from conflicts.
4. Make reorder uniqueness-safe (temporary offset or transaction strategy) and
   validate that supplied IDs exactly belong to the project.
   **Verify**: `pnpm check`.

## Done criteria

- [ ] Concurrent writers cannot commit duplicate project indices.
- [ ] Existing duplicates migrate deterministically.
- [ ] Reorder remains atomic and preserves all chapters.
- [ ] Fresh and upgraded database tests pass.

## STOP conditions

Stop if the Bun worker dialect cannot provide a transaction mode that serializes
allocation; report dialect behavior before relying on process-local locks alone.

## Maintenance notes

The database unique index is authoritative; application serialization is an
optimization and clearer error boundary, not the sole guarantee.
