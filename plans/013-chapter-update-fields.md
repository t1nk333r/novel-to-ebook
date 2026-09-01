# Plan 013: Restrict chapter updates to editable fields

> **Executor instructions**: Reject structural fields at validation and update
> `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/app/projects/chapters/schema.ts src/app/projects/chapters/routes.ts ui/src/lib/api.schema.d.ts tests`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

The generic update schema admits `id`, `projectId`, and `index`. A title/content
edit can therefore mutate primary ownership and ordering invariants that have
dedicated route semantics.

## Current state

- `src/app/projects/chapters/routes.ts:165-175` parses
  `ChapterSchema.partial()` and passes the entire body to `.set()`.
- UI editors currently send only title/content, so structural mutation is not a
  documented client requirement.

## Commands you will need

`pnpm test -- chapter-update` and `pnpm check` must pass.

## Scope

**In scope**: explicit update DTO, strict validation, generated schema refresh,
route tests.

**Out of scope**: moving chapters between projects or reordering them.

## Steps

1. Add API tests that accept title/content partial updates and reject id,
   projectId, index, unknown keys, and empty bodies.
2. Define `UpdateChapterSchema` as a strict partial pick of title/content and use
   it in the route.
3. Regenerate the UI OpenAPI declaration using the documented typegen flow and
   verify editor callers typecheck. **Verify**: `pnpm check`.

## Done criteria

- [ ] Structural fields cannot reach `.set()`.
- [ ] Existing rename/content editing still works.
- [ ] Generated types expose only title/content.

## STOP conditions

Stop if a current UI caller intentionally sends `index`; move that behavior to the
existing reorder endpoint rather than expanding this DTO.

## Maintenance notes

Future structural operations need dedicated invariant-checked endpoints.
