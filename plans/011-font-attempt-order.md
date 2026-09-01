# Plan 011: Process the first detected obfuscation font

> **Executor instructions**: Preserve the five-attempt cap, expose useful failure
> context without chapter content, and update `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/app/projects/utils.ts src/app/utility/utils.ts tests`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `5b03d47`, 2026-08-30

## Why this matters

Font indexing increments before access, skipping the first detected font. A page
with exactly one obfuscation font can therefore never be decrypted.

## Current state

`src/app/projects/utils.ts:552-572` initializes `fontIdx = 0`, increments at line
561, then reads `fontArr[fontIdx]`, and silently catches every error.

## Commands you will need

`pnpm test -- font-attempts` and `pnpm check` must pass.

## Scope

**In scope**: attempt iteration, dependency seam for font decryption, tests,
non-sensitive error logging.

**Out of scope**: changing the font decryption algorithm or detection heuristic.

## Steps

1. Add tests for zero, one, multiple, more-than-five, first-success, and fallback
   font arrays using a deterministic decrypt function.
2. Replace the index loop with a bounded iteration over `fontArr.slice(0, 5)`.
   Continue after individual failures, but do not pass `undefined`.
3. Log only font origin/index and error type; never chapter content.
   **Verify**: `pnpm check`.

## Done criteria

- [ ] The first font is attempted first.
- [ ] No more than five defined URLs are attempted.
- [ ] Single-font success produces a new map.

## STOP conditions

Stop if font response order is nondeterministic and another authoritative priority
signal exists; report it before inventing ordering.

## Maintenance notes

The attempt cap is a workload safety boundary and must remain aligned with plan 008.
