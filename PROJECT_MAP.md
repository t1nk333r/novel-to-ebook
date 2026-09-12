# Storvi project map

Updated: 2026-09-02. Implementation baseline: `a505f3a` plus the uncommitted
plan-023 work (UI bearer-token transport).

## [TECH_STACK]

- Runtime/server: Bun 1.4, TypeScript, Hono, Zod OpenAPI.
- Persistence: SQLite through Kysely and `kysely-bun-worker`.
- Web extraction: Puppeteer with Ghostery blocking, Cheerio, JSDOM,
  Readability, and font-map decryption.
- Frontend: React, Vite PWA, TanStack Query, Zustand, Tiptap, Foliate submodule.
- Package manager: pnpm 11 workspace; one root lockfile.
- Verification target: root `pnpm check` (tests, types, lint, production build).

## [SYSTEM_FLOW]

1. Operator runs the server locally on loopback, or explicitly enables a remote
   host with bearer authentication.
2. Startup validates configuration, completes SQLite migrations, performs the
   initial library scan, then accepts traffic.
3. Library scan enumerates EPUB/PDF files beneath `DATA_PATH`, incrementally
   enriches changed files, and publishes only the newest complete scan.
4. Reader fetches a book with HTTP validators, uses IndexedDB offline cache, and
   opens only the latest requested book generation.
5. Project editor navigates only to network-policy-approved public HTTP(S) URLs,
   extracts/sanitizes chapters, and queues bounded imports.
6. Chapter writes preserve project ownership and unique project-scoped order.
7. Export resolves a sanitized EPUB destination strictly beneath `DATA_PATH`,
   writes it, then triggers a rescan.

Verifiable goal: `pnpm check` passes and regression tests exercise each numbered
flow without public network, real user data, or secret credentials.

## [ARCHITECTURE]

- `src/index.ts`: configuration, middleware composition, ordered bootstrap.
- `src/app/*/routes.ts`: validated HTTP boundaries; route code stays thin.
- `src/app/*/utils.ts` (and `chapters/repository.ts`, the only repository so far):
  persistence and feature algorithms.
- `src/lib/`: genuinely shared policies (network, limits, browser, queue).
- `src/db/migrations/`: monotonic SQLite schema changes.
- `ui/src/app/`: route-oriented UI features.
- `ui/src/lib/` and `ui/src/hooks/`: shared transport/offline primitives.
- `tests/`: deterministic Bun tests; temporary storage and injected network/browser
  doubles only.

Logging remains simple and non-blocking through console levels. Logs may include
operation type, public URL origin, task ID, and error class; never API tokens,
credentials, book contents, or full AI prompts.

## [ORPHANS & PENDING]

- Plan 016: the library scan re-stats and re-parses every file each pass
  (`src/app/library/utils.ts`); flow step 3's "incrementally enriches changed
  files" is the target, not the current behaviour.
- Plans 020-022: the content selector is still a single string; multi-select,
  iframe support, and the local Ollama backend are follow-up work.

Deferred product directions remain uploads, next-chapter crawling, and in-book search.
