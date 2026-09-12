# Repository Guidelines

## Project Overview

Storvi is a self-hosted EPUB/PDF library, reader, and novel-to-ebook extraction workspace
(`README.md:3`). One operator, no user accounts: the only identity boundary is a single shared
bearer token. Endpoints drive a headless Chromium and can spend AI quota, so treat every route as
privileged.

Three deployment shapes: loopback dev, the `docker-compose.yml` container published on
`0.0.0.0:3000`, and a planned TrueNAS SCALE host.

## Architecture & Data Flow

Two Hono apps in `src/index.ts`: an inner `api` app holding every JSON/SSE route, mounted at `/api`
(`src/index.ts:88`), and an outer app serving the built UI from `./ui/dist`
(`src/index.ts:89`, path is relative to CWD — start the server from the repo root).

Middleware order inside `api` is load-bearing:

1. `content-length` body guard → 413 `REQUEST_TOO_LARGE` (`src/index.ts:22-26`)
2. `bearerAuth` — mounted **only** when `serverConfig.remote && serverConfig.apiToken` (`src/index.ts:27`)
3. feature routers `projects`, `library`, `utility` (`src/index.ts:53-55`)
4. `/proxy/*` CORS proxy (`src/index.ts:58-62`)
5. OpenAPI JSON + Scalar docs, **dev only** (`src/index.ts:66-85`) — `pnpm typegen:ui` depends on them

Bootstrap order: `resolveServerConfig()` → `await runMigration()` → `initScheduler()` (5-minute cron
plus an immediate library rescan, `src/scheduler.ts:5-8`) → `Bun.serve` (`src/index.ts:94-109`).

**Novel → EPUB pipeline** (the product's core loop):

1. `POST /api/projects/snapshot` (SSE) opens a Puppeteer page, runs declarative actions, streams
   `screenshot` events every ~250 ms, then a `result` event carrying the element tree, cleaned HTML,
   and a heuristic content selector (`src/app/projects/routes.ts:313-427`).
2. The UI picker turns clicks into CSS selectors and POSTs the extracted links
   (`ui/src/app/projects/view/components/import-toc-dialog.tsx`).
3. `POST /projects/:id/chapters/import` enqueues one task per link on the shared `QueueManager`,
   namespaced by project id (`src/app/projects/chapters/repository.ts:75-128`); progress streams over
   `GET /projects/:projectId/chapters/import` (SSE, `src/app/projects/chapters/routes.ts:64-103`).
4. Each link goes through `tryExtractContent` (article-extractor → Readability → selector fallback,
   plus font de-obfuscation) and lands via `insertChapterAtNextIndex`.
5. `POST /projects/:id/export` builds the EPUB in memory, resolves a destination through
   `resolveExportDestination`, writes it under `DATA_PATH`, and schedules a rescan 1 s later
   (`src/app/projects/routes.ts:235-307`).

There are exactly **two** SSE endpoints (snapshot, chapter import). Both are consumed by the
hand-rolled fetch client in `ui/src/lib/sse.ts` — not `EventSource`.

UI side: hash router (`ui/src/router.tsx`), TanStack Query through `openapi-react-query` (`$api`),
zustand for state, and an IndexedDB layer (`ui/src/lib/db.ts`) caching queries, images, and whole
books for offline reading. Every browser→API request carries `Authorization: Bearer …` when a token
is stored (`ui/src/lib/api-auth.ts`); a 401 anywhere opens the token gate.

## Key Directories

| Path | Purpose |
|---|---|
| `src/app/<feature>/` | HTTP boundary per feature: `routes.ts` + `schema.ts` (+ `utils.ts`, `context.ts`, `repository.ts`) |
| `src/lib/` | Shared policies and algorithms: `browser`, `queue-mgr`, `limits`, `network-policy`, `export-path`, `auth`, `font-decryptor`, `error` |
| `src/db/` | Kysely instance, generated `types.d.ts`, `migrate.ts`, `migrations/` |
| `ui/src/app/<feature>/` | Route features (`library`, `projects/{list,view}`, `reader`), each with `page.tsx`, `components/`, `lib/` |
| `ui/src/lib/` | Transport and offline: `api.ts`, `api-auth.ts`, `sse.ts`, `db.ts`, `store.ts`, `queryClient.ts` |
| `ui/src/hooks/`, `ui/src/stores/` | Cross-feature hooks; app-wide zustand stores (`app.store.ts`, `auth.store.ts`) |
| `tests/` | All Bun tests, server **and** UI code alike |
| `plans/` | Numbered implementation plans + `plans/README.md` status index |

Do not edit: `ui/src/lib/foliate-js/` (git submodule), `ui/src/components/ui/` (generated shadcn),
`ui/src/lib/api.schema.d.ts` and `src/db/types.d.ts` (both generated — regenerate, never hand-edit).

## Development Commands

```bash
export PATH="$HOME/.local/share/mise/installs/bun/1.4.0/bin:$PATH"   # bun is mise-installed, not on PATH
pnpm install --frozen-lockfile --ignore-scripts                       # --ignore-scripts is mandatory locally
git submodule update --init --recursive                               # only if pnpm build hits ENOENT on foliate-js
```

| Command | Runs | Use when |
|---|---|---|
| `pnpm check` | `test && typecheck && lint && build` | the single verification gate; CI runs exactly this |
| `pnpm test` | `bun test` (preloads `tests/setup.ts`) | one file: `bun test tests/selector.test.ts` |
| `pnpm typecheck` | `tsc -p tsconfig.json` then `tsc -b ui/tsconfig.json` | after any type-visible change |
| `pnpm lint` | `eslint .` inside `ui` only | server code is never linted |
| `pnpm build` | `tsc -b && vite build` → `ui/dist` | required before `pnpm start` |
| `pnpm dev` | `dev:server` (bun --watch, :3000) + `dev:ui` (vite, :5173) | normal loop; Vite proxies `/api` → `localhost:3000` |
| `pnpm typegen:server` | `kysely-codegen` → `src/db/types.d.ts` | after a migration; needs a compiled better-sqlite3 (see below) |
| `pnpm typegen:ui` | `openapi-typescript` → `ui/src/lib/api.schema.d.ts` | after route/schema changes; **needs `pnpm dev:server` running** (docs route is dev-only) |

`pnpm start` runs `prestart` → `src/preflight.ts`, which fails fast without `DATABASE_URL` or
`ui/dist/index.html`.

## Code Conventions & Common Patterns

**Routes.** Every endpoint is `router.method(path, openApi({ tags, summary, request, responses }), handler)`;
read input with `c.req.valid("json"|"param"|"query")`, reply with `c.var.res(payload)` or
`c.var.res(status, payload)` (`src/app/projects/routes.ts:51-70`). `c.var.res` only exists on
`openApi()`-wrapped routes and throws if the status is absent from `responses`. Response bodies are
**not** runtime-validated — a wrong shape ships silently and only surfaces as a UI type mismatch.

**Schemas.** Zod v4 in `src/app/<feature>/schema.ts`, composed with `.pick/.omit/.partial`. Anything
user-sized must be bounded by a constant from `src/lib/limits.ts` (`src/app/projects/schema.ts:4,36-38`).

**Errors.** Throw `HTTPError` (extends `HTTPException`, carries a `code`, `src/lib/error.ts:4-14`);
`api.onError` serializes `{ error, message, code }` centrally (`src/index.ts:35-50`). Never build ad-hoc
error responses in handlers.

**Database.** Kysely query builder on the default export from `src/db`. Raw `sql` templates only where
the builder cannot express it. Migrations are `src/db/migrations/NNNN-kebab-name.ts` exporting
`MigrationNNNN` with `up`/`down`, registered in `src/db/migrations/index.ts`.

**Security guards — never bypass.** Any outbound URL goes through `assertSafeOutboundUrl` / `safeFetch`
(`src/lib/network-policy.ts`); any file write goes through `resolveExportDestination`
(`src/lib/export-path.ts`). Both have tests in `tests/security-boundaries.test.ts`.

**Background work.** Long jobs use the namespaced `QueueManager` (`src/lib/queue-mgr.ts`); request-scoped
timers use `startPeriodicTask` and must be stopped in a `finally` (`src/lib/periodic-task.ts`).

**UI.** Data via `$api.useQuery/useMutation` and `invalidateQuery(path, init?)`; modal state via
`createDisclosure()` exported from the component's module (`ui/src/lib/store.ts`); persisted prefs via
`usePersistedState` or a zustand `persist` store keyed `app/*`. Files are kebab-case; each feature owns
`page.tsx`, `components/`, `lib/`.

**Style rules that get enforced in review, not by tooling.** No one-line wrapper functions unless three
or more call sites need lockstep behaviour. Clean cutover: migrate callers, delete the old path, no
compatibility aliases.

### Landmines (fail at runtime, invisible to typecheck and tests)

- **`getSelector` and `getCleanHTML` exist twice on purpose.** `extractElements` is passed by reference
  to `page.evaluate` (`src/app/projects/routes.ts:399-403`), so it is stringified and run inside the
  page: it cannot reference module scope. The inline copy at `src/app/projects/utils.ts:58-100`
  shadows the exported one at `:273-330`. Merging them, or hoisting a constant out of `getCleanHTML`
  (`:173-216`), produces a page-side `ReferenceError` that nothing catches. Edit both copies together.
  Same rule for every inline arrow passed to `page.evaluate` in `src/lib/browser.ts` and
  `src/app/projects/utils.ts` — no closures over imports, `limits`, or schemas.
- **`index` is a reserved SQLite keyword and a real column** (`project_chapters.index`). Kysely quotes
  identifiers; raw `sql` template fragments do not: the `max("index")` and `"index" + 1000000`
  (`src/app/projects/chapters/repository.ts:35,157`) must keep their quotes — dropping them is a
  syntax error at runtime only.
- **Chapter route order:** `GET /import` must stay registered before `GET /:id`
  (`src/app/projects/chapters/routes.ts:64` vs `:107`), or Hono matches `/:id` and 400s on `"import"`.
- **Chapter ordering invariants:** `(projectId, index)` is UNIQUE. Index allocation must stay inside
  the transaction + retry loop; reorder must keep the two-phase `+1000000` shift.
- **Import SSE is namespace-filtered** by project id on both sides; changing one side silently empties
  the progress UI.
- **`backend/*` (→ `../src/*`) is a tsconfig-only alias** with no Vite counterpart: type-only imports
  in UI code, never value imports.
- **Browser transport invariant:** every UI→`/api` request must be a JS `fetch` so the bearer header can
  be attached. Adding an `EventSource`, `<img src="/api/…">`, `<iframe src="/api/…">`, or an anchor
  download to an API URL breaks auth silently — fetch it and use a blob URL, as `OfflineImage` does.

## Important Files

| File | Why it matters |
|---|---|
| `src/index.ts` | App assembly, middleware order, bootstrap sequence |
| `src/lib/auth.ts` | `resolveServerConfig` (HOST/API_TOKEN/ALLOW_INSECURE_BIND rules) and `bearerAuth` |
| `src/lib/limits.ts` | Every request ceiling; env-overridable, throws at import on bad values |
| `src/lib/network-policy.ts`, `src/lib/export-path.ts` | SSRF and path-traversal boundaries |
| `src/app/projects/utils.ts` | Extraction/selector core; hosts both browser-serialized functions |
| `src/app/projects/chapters/repository.ts` | Order allocation, import worker, reorder |
| `src/db/index.ts` | Kysely singleton; **throws at module load without `DATABASE_URL`** |
| `ui/src/lib/api.ts`, `api-auth.ts`, `sse.ts`, `hooks/use-offline.ts` | The four browser→API transports |
| `.env.example` | The real configuration contract (README documents only a subset) |
| `plans/README.md` | Plan status index and reconciliation log |
| `PROJECT_MAP.md` | Numbered system flow, architecture layers, and the current `[ORPHANS & PENDING]` gap list |

## Runtime/Tooling Preferences

- **Bun 1.4.0 runs the server and the tests; Node 24 + Vite build the UI.** pnpm 11.24.0 is the only
  package manager (`packageManager` field); npm/yarn/bun install are wrong here.
- **`--ignore-scripts` on local install is deliberate.** `better-sqlite3` is a devDependency used only by
  `typegen:server`; its native addon does not compile against the local Node 26 headers. Nothing in
  `src/` imports it (runtime SQLite is `kysely-bun-worker` → `bun:sqlite`). Never "fix" this by editing
  `package.json`, `pnpm-workspace.yaml`, or the lockfile. Consequence: `pnpm typegen:server` cannot run
  in a `--ignore-scripts` tree.
- **Never create a `.env`.** Bun auto-loads it and it would leak into test runs; `.env.example` is
  documentation only.
- **TypeScript:** `verbatimModuleSyntax` (use `import type`), `noUncheckedIndexedAccess` on the server
  only, `erasableSyntaxOnly` in the UI (no enums, no parameter properties). `tsconfig.json` includes
  `src` only — `tests/` is not typechecked.
- **Lint expectation:** 0 errors, warnings tolerated (baseline 23). `any` and `@ts-ignore` are allowed in
  UI code. Do not clean pre-existing warnings inside an unrelated change.
- **Tailwind v4 via `@tailwindcss/vite`** — no `tailwind.config.*`; theme lives in `ui/src/index.css`.
  shadcn components are generated (`ui/components.json`, style `new-york`, lucide icons).
- **Auth semantics** (`src/lib/auth.ts`): loopback `HOST` needs no token; a non-loopback `HOST` requires
  `API_TOKEN` or an explicit `ALLOW_INSECURE_BIND=1`, else startup throws. `ALLOW_INSECURE_BIND` never
  disables auth — a configured token is still enforced.
- Docker requires `sudo` on this machine; the operator is not in the `docker` group.

## Testing & QA

- **Runner:** `bun:test`. All tests live in the root `tests/` directory regardless of which side they
  cover — `tests/reader-load-coordinator.test.ts` and `tests/api-auth-transport.test.ts` import UI
  modules by relative path (`../ui/src/...`). A UI module imported from a test must therefore be
  dependency-free: the `@/` alias and DOM globals do not resolve under `bun test`.
- **Setup:** `bunfig.toml` preloads `tests/setup.ts`, which points `DATABASE_URL` at a fresh temp SQLite
  file when unset. This exists because importing most `src/` modules transitively pulls `src/db/index.ts`,
  which throws at module load without it.
- **Isolation rule:** if a test mutates `process.env`, it must restore the previous value in `afterAll`
  (`tests/book-cache.test.ts:97-150` is the pattern). A test that left `DATABASE_URL` pointing into a
  deleted temp dir once broke every later file, and only in one file order — always run the whole suite,
  not just your file.
- **Known Bun trap:** `expect(promise).rejects.toThrow()` *hangs* (until the 5 s timeout) when the promise
  resolves through the `kysely-bun-worker` Worker dialect. Use the `assertRejects` try/catch helper in
  `tests/chapter-order.test.ts:32-40`. Plain `.rejects` is fine elsewhere
  (`tests/security-boundaries.test.ts:14`).
- **What a test must earn its place with:** an observable contract that a plausible bug would break —
  ordering invariants, security boundaries, cache validators, selector uniqueness. Do not add tests that
  assert wiring, defaults, or source text. There is no coverage tooling and no coverage target.
- **CI** (`.github/workflows/ci.yml`) checks out submodules recursively, pins pnpm 11.24.0 / Bun 1.4.0 /
  Node 24, runs `pnpm install --frozen-lockfile` (no `--ignore-scripts` — Node 24 compiles the addon) and
  then `pnpm check`.
- **UI changes need visual proof.** There is no UI test runner; verify by running the app and exercising
  the path. Auth-dependent flows need a non-loopback bind:
  `HOST=0.0.0.0 API_TOKEN=<throwaway> PORT=3010 DATABASE_URL=/tmp/scratch.sqlite bun run src/index.ts`.

## Working With `plans/`

Numbered, self-contained implementation plans; `plans/README.md` carries the status table
(`TODO | IN PROGRESS | DONE | BLOCKED | REJECTED`) and a dated reconciliation log with per-plan evidence.
When you finish work covered by a plan, update its status row and add a log entry; when execution
diverges from the plan text, amend the plan to match.

Currently open: **016** (incremental library scan), the **020 → 021 → 022** selector chain (020 landed
2026-09-12; 021 and 022 remain), **024** (per-navigation browser policy — the Puppeteer paths check only
the entry URL), **025** (a stacked-dialog defect that can leave the Add Chapter form inert after using
the picker), and **026** (export-time image URLs bypass the SSRF policy). 016 and the 021/022 pair
rewrite `src/app/projects/utils.ts` and must run in that order — they cannot be parallelized.

A `DONE` marking is not proof: several plans were marked done while failing their own criteria. Re-check
against the working tree before relying on one.
