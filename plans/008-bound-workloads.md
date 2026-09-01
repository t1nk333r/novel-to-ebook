# Plan 008: Bound browser, import, fetch, and AI workloads

> **Executor instructions**: Put limits at validated request and shared execution
> boundaries; keep them configurable and update `plans/README.md`.
>
> **Drift check**: `git diff --stat 5b03d47..HEAD -- src/app/projects src/app/utility src/lib/browser.ts src/index.ts tests README.md`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/004-protect-remote-api.md`, `plans/005-safe-outbound-urls.md`
- **Category**: security
- **Planned at**: commit `5b03d47`, 2026-08-30

## Reconciliation 2026-08-31

This plan was marked DONE and has been **reopened as partially complete**. Steps 1,
2 and 4 landed: `src/lib/limits.ts` defines named bounds, `src/app/projects/schema.ts`
applies them as Zod maxima (`schema.ts:4,38-40,53,77-80,88,144-145`), and
`src/lib/network-policy.ts` caps fetched bytes.

**What remains is step 3 only.** `src/lib/bounded-executor.ts` was written but is
**never imported** — `grep -rn "bounded-executor\|BoundedExecutor" src/ ui/src`
matches only its own definition. Done criterion "Concurrency slots release on
success, error, and abort" therefore cannot hold: no browser or AI call passes
through a semaphore.

Remaining work: wire `BoundedExecutor` around the browser-page and AI-translation
call sites, release in `finally`, propagate request abort, return 429 on
saturation, and add the concurrency test named in the Commands table. Everything
else in this plan is already satisfied — do not redo it.

## Why this matters

Validated inputs currently have no useful upper bounds, while screenshots,
browser pages, font buffers, imports, and AI calls are expensive. A caller can
occupy the process or external quota far beyond one normal chapter operation.

## Current state

- `src/app/projects/schema.ts:134-143` leaves dimensions/actions/lists unbounded.
- `src/app/projects/routes.ts:353-356` allows full document screenshot height.
- `src/app/projects/chapters/routes.ts:215-218` accepts unlimited links/delay.
- `src/app/utility/utils.ts:16-18` fully buffers a font response.
- `src/app/projects/schema.ts:172` has no maximum translation size.

## Commands you will need

`pnpm test -- limits`, `pnpm test -- concurrency`, and `pnpm check` must pass.

## Scope

**In scope**: named configuration limits, Zod maxima, fetch byte/deadline bounds,
browser/AI global concurrency, cancellation, 413/429 responses, documentation.

**Out of scope**: distributed rate limiting, billing, per-user quotas.

## Steps

1. Define conservative defaults for request body, text, links, actions, delays,
   screenshot pixels, fetched bytes, and concurrent browser/AI work. Add tests at
   limit, over limit, timeout, and concurrency saturation.
2. Enforce cheap schema/body limits before work starts; return stable 4xx errors.
3. Add shared bounded executors/semaphores with `finally` release and request
   cancellation for browser and AI operations. Cap manual-redirect fetch bodies.
4. Document environment overrides and safe ranges. **Verify**: `pnpm check`.

## Done criteria

- [ ] Every listed expensive input has a tested upper bound.
- [ ] Concurrency slots release on success, error, and abort.
- [ ] Full-page screenshots have a hard pixel cap.
- [ ] Over-limit calls return 413/429 without starting work.

## STOP conditions

Stop if representative chapters exceed proposed defaults; report observed sizes
and choose limits from fixtures rather than silently truncating content.

## Maintenance notes

Limit changes are operational API changes and must remain documented and tested.
