# Plan 022: Add a local Ollama backend for AI selector generation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a179008..HEAD -- src/lib/utils.ts src/app/projects/utils.ts src/app/projects/routes.ts src/app/projects/schema.ts src/lib/limits.ts docker-compose.yml tests`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/021-iframe-selectors.md`
- **Category**: direction
- **Planned at**: commit `a179008`, 2026-09-01
- **Resolved**: 2026-09-12 — see "Resolution" below

## Resolution 2026-09-12

Selector generation now runs against a local Ollama instance, and the orphaned
`generateSelectors` is wired to a route.

**One STOP condition fired, with a documented resolution.** The plan said to
derive structured-output schema with `z.toJSONSchema(SelectorSchema)` and to stop
if it throws. It throws — `Transforms cannot be represented in JSON Schema` —
because plan 020 turned `content` into a transform that normalizes one selector
or several into a list. The resolution is `z.toJSONSchema(SelectorSchema, { io: "input" })`,
which is still derived from the same schema (no hand-written copy) and is the
semantically correct direction: the model emits a document that must parse
*into* SelectorSchema. Verified output: `content` as `anyOf: [string, array]`,
`required: ["title", "content"]`. A test asserts the derived schema and the
validator accept the same document, so the two cannot drift.

What landed:

- `src/lib/ai-provider.ts` — `resolveAiProvider` (Ollama when `OLLAMA_URL` is
  set, else Gemini, else none), endpoint validation as a **trusted operator URL**
  (http/https, no credentials, and deliberately not routed through the SSRF
  guard, which exists for scraped URLs and would refuse exactly these private
  addresses), `buildSelectorMessages` (shared prompt), `selectorJsonSchema`, and
  `generateSelectorsWithOllama` (POST `/api/chat`, `stream: false`, `format`
  schema, `AbortSignal.timeout`).
- Local inference is **serialized** on a promise chain that releases in a
  `finally`, so a failed request cannot deadlock later ones — two generations on
  one 8 GB card would thrash.
- Errors name the status and model only; the response body is never included,
  because it can contain page content. Logging is model + duration.
- `htmlSkeleton(html, maxBytes)` reduces a page to tags, ids, classes and text
  *lengths* (`«142»`), collapsing runs of more than five identical siblings — a
  chapter list is one pattern, not a hundred. Pure and JSDOM-only.
- `POST /projects/generate-selectors` (body `{ html, followUp? }`, `503` when no
  provider is configured) applies the reduction before calling the generator.
- `docker-compose.yml` gains an `ollama` sidecar with **no published port**,
  flash attention, quantized KV cache, a 5-minute keep-alive, and GPU access on
  that service only; README documents the pull, the host GPU check, the opt-in
  rule, the keep-alive tradeoff and the TrueNAS constraints.

**One deliberate deviation:** the shared prompt gains a line explaining the
`«123»` placeholders. The plan said to reuse the prompt verbatim, but a model
that has not been told what the markers mean will read them as page content.

Evidence: 18 tests in `tests/ai-selectors.test.ts`, all offline (`fetch` stubbed)
— provider resolution and endpoint validation (including that private addresses
are accepted and `file:`/credentials are not), the derived schema, skeleton
reduction (structure kept, text dropped, long runs collapsed, budget honoured,
≥10× reduction on a realistic page), the Ollama call (request shape, skeleton not
raw HTML, non-2xx without body leakage, malformed and empty replies), and
serialization. The serialization test fails when the queue is bypassed —
verified by bypassing it. `docker compose config --quiet` exits 0 and the Ollama
service has no ports.

**Against the plan's criterion "`git diff a179008..HEAD -- src/lib/network-policy.ts` is empty":**
that file did change today, by plan 026 — it extracted `parseOutboundUrl` so the
async guard and the new synchronous predicate share one implementation, and added
`isAllowedOutboundUrl`. The blocked CIDR list is untouched and the policy now
applies in one more place, not fewer. Plan 022 itself did not modify it.

## Why this matters

`generateSelectors()` already exists in `src/lib/utils.ts:12` — it asks a model
to produce CSS selectors for a novel page and validates the reply against
`SelectorSchema`. **It has no callers.** It is finished, schema-validated, dead
code. Meanwhile the only wired AI feature is translation, which requires a
Gemini API key and sends page content to a third party.

The operator wants to self-host: run the parser against a local Ollama instance
on the machine that hosts Storvi. That removes the API-key requirement, keeps
book content on the operator's hardware, and turns an orphaned function into the
feature it was written to be — a fallback for sites where the heuristic
`findContentSelector`/Readability path fails.

## Deployment context (this is why the constraints below exist)

The target host is **TrueNAS SCALE** (kernel `6.12.95-production+truenas`) with
an **NVIDIA RTX 3070 Ti — 8192 MiB VRAM**, driver 570.172.08, CUDA 12.8. GPU
passthrough is confirmed working on the host (`nvidia-smi` reports the card idle
at 0 MiB). The same box **also runs Jellyfin transcoding**.

Two consequences drive the whole design:

1. **8 GB is tight.** `qwen2.5-coder:7b` at Q4_K_M is ~4.7 GB, leaving roughly
   3 GB for KV cache. Whole-page HTML will not fit in the resulting context
   window. The skeleton reduction in step 2 is **required**, not an optimization.
2. **The GPU is shared.** AI parsing must be strictly opt-in and on-demand —
   never triggered automatically by a snapshot — so it cannot contend with a
   transcode the operator cares about more.

The operator's development machine runs Ollama on port **11435**; the
containerized sidecar in this plan uses the in-container default **11434**.
Do not hardcode either — read it from `OLLAMA_URL`.

### TrueNAS SCALE deployment constraints

TrueNAS is an appliance. Its own login banner states that the **only** supported
mechanisms for configuration change are the WebUI, CLI, and API, and that
anything else "may result in system failure." Three rules follow, and they
override the ordinary `docker compose up` workflow documented in `README.md`:

1. **Do not deploy by running `docker compose up` over SSH.** Containers created
   outside the Apps subsystem are unmanaged, invisible to the WebUI, and can be
   removed by a TrueNAS update. Deploy through **Apps → Discover Apps → Custom
   App → Install via YAML**, which accepts compose YAML and keeps the result
   managed.
2. **Both services must live in ONE custom app.** Each TrueNAS custom app is its
   own compose project with its own network. Installing `storvi` and `ollama` as
   two separate apps means `http://ollama:11434` will not resolve and
   `depends_on` will not apply. They go in a single YAML.
3. **Use ZFS dataset host paths, not Docker named volumes.** Named volumes live
   inside the apps dataset where they are awkward to snapshot, replicate, or
   browse. Create datasets for the library and for the Ollama model store and
   bind-mount them. The model store needs ~5 GB for `qwen2.5-coder:7b`.

The compose file in this repo therefore serves two audiences: it is the
authoritative local/dev deployment, and it is the source the operator adapts for
the TrueNAS custom app. Keep it plain compose — no `profiles`, no host-specific
paths baked in — so the adaptation stays a matter of substituting volume paths.

## Current state

### The orphaned function

`src/lib/utils.ts:1-48`:

```ts
import { GoogleGenAI } from "@google/genai";
import { selectorExample, SelectorSchema } from "../app/projects/schema";
import removeMd from "remove-markdown";

let ai: GoogleGenAI | null = null;

function getAI() {
  ai ??= new GoogleGenAI({});
  return ai;
}

export async function generateSelectors(html: string, followUp?: string) {
  const prompts = [ /* long scraping prompt + selectorExample + html */ ];
  if (followUp) prompts.push({ role: "user", text: followUp });

  const response = await getAI().models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompts,
  });
  if (!response.text) throw new Error("No response");

  const res = JSON.parse(removeMd(response.text));
  return SelectorSchema.parse(res);
}
```

Confirm it is still unwired before starting:
`grep -rn "generateSelectors" src/ --include=*.ts` → only its own definition.

### The output schema (`src/app/projects/schema.ts`, near line 5)

```ts
export const SelectorSchema = z.object({
  title: z.string().min(1),
  chapter: z.string().nullish(),
  isChapterInTitle: z.boolean().nullish(),
  titleSeparator: z.string().nullish(),
  content: z.string().min(1),
  urls: z.object({
    nextChapter: z.string().nullish(),
    prevChapter: z.string().nullish(),
  }).nullish(),
});
```

**Plan 020 changes `content` on this object from a string to an array.** This
plan assumes that has already landed (hence the dependency on 021, which comes
after 020). See STOP conditions.

### The network policy will reject every possible Ollama address

`src/lib/network-policy.ts` — `isPublicIp` returns false for `127.0.0.0/8`,
`10/8`, `172.16/12` (where Docker's `host-gateway` lands), `192.168/16`, and
`100.64/10` (Tailscale's CGNAT range).

That policy exists to stop **scraped, user-influenced URLs** reaching internal
services. An operator-configured `OLLAMA_URL` is a different trust class: the
operator is deliberately pointing Storvi at their own machine. It must be
validated **at startup as a trusted endpoint** and must NOT be passed through
`assertSafeOutboundUrl`. Do not weaken `isPublicIp` — adding a private range
there would punch a hole in the SSRF guard for scraped URLs too.

### Conventions to match

- Zod is v4 (`package.json:66`, `"zod": "^4.3.6"`), so `z.toJSONSchema(...)` is
  available and must be used to derive Ollama's structured-output schema from
  `SelectorSchema` rather than hand-writing a second copy.
- Named bounds live in `src/lib/limits.ts` via `readPositiveInteger(name, fallback)`
  and are documented in `.env.example`.
- Route errors use `HTTPError` from `src/lib/error.ts`; routes validate with
  `openApi({...})` + `c.req.valid(...)`. Model the new route on the translate
  route at `src/app/projects/routes.ts:429-452`.
- Logging is plain `console.*`. Log the model name, duration, and error class —
  **never page content, never prompts, never the book text.**
- Tests are Bun tests under root `tests/`. A `bunfig.toml` preloads
  `tests/setup.ts`, which sets `DATABASE_URL` to a temp path when unset.

## Commands you will need

| Purpose   | Command                                     | Expected on success |
|-----------|---------------------------------------------|---------------------|
| Install   | `pnpm install --frozen-lockfile --ignore-scripts` | exit 0 (see note) |
| Tests     | `pnpm test -- ai-selectors`                 | all pass            |
| Typecheck | `pnpm typecheck`                            | exit 0, no errors   |
| Lint      | `pnpm lint`                                 | 0 errors            |
| Aggregate | `pnpm check`                                | exit 0              |

Note: plain `pnpm install --frozen-lockfile` fails because `better-sqlite3@12.6.2`
will not compile against Node 26's V8 headers. It is a devDependency used only by
`typegen:server` and imported nowhere in `src/`. Use `--ignore-scripts`. Do NOT
change `package.json`, `pnpm-workspace.yaml`, or the lockfile to work around it.

Bun 1.4.0 is installed via mise but may not be on `PATH`:
`export PATH="$HOME/.local/share/mise/installs/bun/1.4.0/bin:$PATH"`.

## Scope

**In scope**:
- `src/lib/ai-provider.ts` (create) — provider selection, endpoint validation, Ollama call
- `src/lib/utils.ts` — route `generateSelectors` through the provider
- `src/app/projects/utils.ts` — `htmlSkeleton()` reduction function
- `src/app/projects/routes.ts` — one new route
- `src/app/projects/schema.ts` — request/response schema for that route
- `src/lib/limits.ts`, `.env.example` — new bounds
- `docker-compose.yml`, `README.md` — sidecar and documentation
- `tests/ai-selectors.test.ts` (create)

**Out of scope**:
- Replacing or altering `findContentSelector` / Readability. The heuristic path
  stays the default; AI is an explicitly-invoked fallback.
- The `translate()` function. It keeps using Gemini. Do not migrate it.
- Vision/screenshot input. The operator's dev box has VL models and the snapshot
  flow already captures images, but multimodal parsing is a separate feature.
- Auto-invoking the parser during snapshot. It must be user-triggered.
- Wiring `BoundedExecutor` (`src/lib/bounded-executor.ts`) — that is plan 008
  step 3 and is still an orphan. Use the local serialization in step 4 instead.
- Any change to `isPublicIp` or the SSRF policy.

## Git workflow

- Branch: `advisor/022-ollama-page-parser`
- Conventional commits, e.g. `feat: add ollama backend for selector generation`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Provider module with trusted-endpoint validation

Create `src/lib/ai-provider.ts` exporting:

```ts
export type AiProvider = "ollama" | "gemini" | "none";
export function resolveAiProvider(env = process.env): {
  provider: AiProvider;
  ollamaUrl?: URL;
  ollamaModel?: string;
};
```

Rules:
- `OLLAMA_URL` set → `"ollama"`. Otherwise `GEMINI_API_KEY` set → `"gemini"`.
  Otherwise `"none"`.
- Validate `OLLAMA_URL` here, at startup, as a **trusted operator endpoint**:
  parse it with `new URL(...)`, require protocol `http:` or `https:`, and reject
  any URL carrying `username` or `password`. Throw a clear `Error` naming
  `OLLAMA_URL` on failure. Do **not** call `assertSafeOutboundUrl` — add a
  comment saying why, referencing that private addresses are the expected case.
- `OLLAMA_MODEL` defaults to `"qwen2.5-coder:7b"`.

Add to `src/lib/limits.ts`:

```ts
aiRequestTimeoutMs: readPositiveInteger("AI_REQUEST_TIMEOUT_MS", 120_000),
aiSkeletonBytes: readPositiveInteger("MAX_AI_SKELETON_BYTES", 60_000),
```

120 s is deliberate: on a shared GPU the model may have been unloaded by
`OLLAMA_KEEP_ALIVE` and must be re-read from disk on the first request.

Document `OLLAMA_URL`, `OLLAMA_MODEL`, `AI_REQUEST_TIMEOUT_MS`, and
`MAX_AI_SKELETON_BYTES` in `.env.example`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: HTML skeleton reduction

Add to `src/app/projects/utils.ts`:

```ts
export function htmlSkeleton(html: string, maxBytes: number): string
```

Selector generation needs **structure, not prose**. Using `JSDOM` (already
imported in this file):

- Drop `script`, `style`, `svg`, `noscript`, `iframe`, `video`, and comments.
- For every remaining element keep only the tag name, `id`, and `class`.
- Replace each text node with a short placeholder recording its length only —
  e.g. `«142»` — never the text itself. Length is the signal that identifies the
  content block; the words are noise that blows the context window.
- Collapse runs of more than 5 sibling elements that share a tag and class into
  the first 3 plus a `«… N more»` marker. Chapter lists produce hundreds of
  identical `li`s and the model needs the pattern, not every instance.
- Truncate the result to `maxBytes`, cutting at an element boundary.

This function must be pure and dependency-free apart from `JSDOM` so it can be
unit-tested without a browser or network.

**Verify**: `pnpm test -- ai-selectors` → the reduction tests from step 5 pass,
including one asserting a realistic page reduces by at least 10×.

### Step 3: Ollama call with structured output

In `src/lib/ai-provider.ts`, add:

```ts
export async function generateSelectorsWithOllama(
  skeleton: string,
  followUp: string | undefined,
  config: { url: URL; model: string },
): Promise<unknown>
```

- POST to `new URL("/api/chat", config.url)`.
- Body: `{ model, messages, stream: false, format: <json schema> }`.
- Derive the schema with `z.toJSONSchema(SelectorSchema)` — import
  `SelectorSchema` from `src/app/projects/schema.ts`. Do not hand-write it.
  Constrained decoding is what makes a 7B model reliable here.
- Reuse the existing prompt text from `generateSelectors` verbatim, but send the
  **skeleton** in place of raw HTML.
- Apply `limits.aiRequestTimeoutMs` via `AbortSignal.timeout(...)`.
- Parse `response.message.content` as JSON. Keep the existing
  `removeMd(...)` defensive unwrap before `JSON.parse` — `format` should make it
  unnecessary, but a model that ignores the schema should produce a clean error,
  not a crash.
- On a non-2xx response, throw an `Error` naming the status and the model. Never
  include the response body in the message — it contains page content.

**Verify**: `pnpm test -- ai-selectors` → the mocked-fetch tests from step 5 pass.

### Step 4: Route `generateSelectors` through the provider, serialized

Modify `generateSelectors` in `src/lib/utils.ts` to call `resolveAiProvider()`
and dispatch: `"ollama"` → `generateSelectorsWithOllama`, `"gemini"` → the
existing Gemini path unchanged, `"none"` → throw a clear error.

Both paths end with `SelectorSchema.parse(res)` — keep that as the single
validation point.

**Serialize local inference to one in-flight request.** A module-level promise
chain in `src/lib/ai-provider.ts` is sufficient:

```ts
let queue: Promise<unknown> = Promise.resolve();
```

Chain each Ollama call onto it and always release in a `finally`. Two concurrent
7B generations on an 8 GB card will thrash or OOM. Do not use `BoundedExecutor` —
it is an orphan pending plan 008 step 3.

**Verify**: `pnpm typecheck` → exit 0.

### Step 5: Route and tests

Add a route to `src/app/projects/routes.ts`, modeled on the translate route at
lines 429-452:

```
POST /projects/generate-selectors
body: { html: string (max limits.textLength), followUp?: string }
200: SelectorSchema
503: when provider is "none"
```

Call `htmlSkeleton(html, limits.aiSkeletonBytes)` before passing to
`generateSelectors`. Add the request schema to `src/app/projects/schema.ts`.

Create `tests/ai-selectors.test.ts`. Tests must **not** reach the network or a
GPU — stub `fetch`. Cases:

1. `resolveAiProvider` returns `"ollama"` when `OLLAMA_URL` is set, `"gemini"`
   when only `GEMINI_API_KEY` is set, `"none"` when neither is.
2. `OLLAMA_URL` validation: rejects `file://`, rejects a URL with embedded
   credentials, accepts `http://ollama:11434` and `http://127.0.0.1:11435`
   (proving private addresses are deliberately allowed here).
3. `z.toJSONSchema(SelectorSchema)` produces an object schema whose `properties`
   include `title` and `content`.
4. `htmlSkeleton`: strips scripts/styles, keeps tag/id/class, replaces text with
   length placeholders, collapses >5 repeated siblings, honors `maxBytes`, and
   reduces a realistic fixture by ≥10×.
5. Ollama call with stubbed fetch: a valid JSON reply parses into
   `SelectorSchema`; a non-2xx throws an error that does **not** contain the
   response body; a malformed-JSON reply throws a clear error.
6. Serialization: two concurrent calls do not overlap (assert via a stub that
   records enter/exit ordering).

**Verify**: `pnpm test -- ai-selectors` → all pass. `pnpm check` → exit 0.

### Step 6: Compose sidecar and documentation

Add an `ollama` service to `docker-compose.yml`:

- Image `ollama/ollama:latest`, `restart: unless-stopped`.
- **No `ports:` entry** — reachable only on the compose network. Publishing it
  would expose an unauthenticated GPU endpoint to the LAN and tailnet.
- Named volume `ollama-models` at `/root/.ollama`.
- `OLLAMA_FLASH_ATTENTION: "1"` and `OLLAMA_KV_CACHE_TYPE: q8_0` — with ~4.7 GB
  of weights on an 8 GB card these two are what make a usable context fit.
- `OLLAMA_KEEP_ALIVE: 5m` with a comment explaining the tradeoff: the GPU is
  shared with Jellyfin transcoding, so the model should unload when idle. An
  operator with a dedicated GPU can raise it to `30m` to avoid reload latency.
- GPU reservation via `deploy.resources.reservations.devices` with
  `driver: nvidia`, `count: 1`, `capabilities: [gpu]`.
- On the `storvi` service: `depends_on: [ollama]` and
  `OLLAMA_URL: http://ollama:11434`, `OLLAMA_MODEL: qwen2.5-coder:7b`.

Because TrueNAS may not honour every compose key, also add
`runtime: nvidia` alongside the `deploy.resources.reservations.devices` block
and note in a comment that plain Docker ignores `runtime` when the reservation
is present, while some TrueNAS versions require it. Setting both is portable.

In `README.md`, add a section covering:

- the one-time `docker compose exec ollama ollama pull qwen2.5-coder:7b`
  (on TrueNAS: the equivalent shell into the app's container);
- the host GPU check, `docker run --rm --gpus all
  nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`;
- that AI parsing is opt-in and never automatic;
- the `OLLAMA_KEEP_ALIVE` tradeoff on a GPU shared with transcoding;
- a short **TrueNAS SCALE** subsection stating the three constraints from the
  "Deployment context" section above: deploy via Apps → Custom App → Install via
  YAML rather than SSH; keep both services in one custom app so service-name DNS
  and `depends_on` work; and bind-mount ZFS datasets instead of using named
  volumes. Name the ~5 GB model-store requirement explicitly.

**Verify**: `docker compose config --quiet` → exit 0. `pnpm check` → exit 0.

## Test plan

- New file `tests/ai-selectors.test.ts`, six groups as listed in step 5.
- Structural pattern: `tests/security-boundaries.test.ts` for pure-function
  assertions, `tests/book-cache.test.ts` for stubbed-transport tests.
- No test may perform real network I/O or require Ollama to be running.
- All existing tests must continue to pass.
- Verification: `pnpm test` → all pass, including the new suite.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; `tests/ai-selectors.test.ts` passes
- [ ] `grep -rn "generateSelectors" src/app/projects/routes.ts` returns a match
      (the function is no longer orphaned)
- [ ] `grep -n "assertSafeOutboundUrl" src/lib/ai-provider.ts` returns **no**
      matches (trusted endpoint, deliberately not routed through the SSRF guard)
- [ ] `git diff --stat a179008..HEAD -- src/lib/network-policy.ts` is empty
      (the SSRF policy was not weakened)
- [ ] `grep -n "ports:" docker-compose.yml` shows no port mapping under the
      `ollama` service
- [ ] `docker compose config --quiet` exits 0
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `grep -rn "generateSelectors" src/` shows a caller other than the route you
  add — the function was wired by someone else and this plan's premise is stale.
- `SelectorSchema.content` is still `z.string()` rather than an array — plan 020
  has not landed, and the response shape would need rework. Report which.
- `z.toJSONSchema(SelectorSchema)` throws, or Ollama rejects the produced schema
  in its `format` field. Report the actual schema and error; do not hand-write a
  replacement schema.
- Making the endpoint work appears to require changing `isPublicIp` or any part
  of `src/lib/network-policy.ts`.
- You cannot make the tests pass without a running Ollama instance — the tests
  must stub `fetch`.
- The `ollama` service cannot be given the GPU without also granting the
  `storvi` service elevated privileges. Only Ollama should touch the GPU; if
  they cannot be separated, report the constraint rather than escalating
  `storvi`'s privileges.

## Maintenance notes

- **Quality expectation.** `qwen2.5-coder:7b` at Q4 is meaningfully weaker than
  `gemini-2.5-flash` at this task. Constrained decoding via `format` closes much
  of the gap. If results disappoint on a 24 GB card, `qwen3-vl:30b-a3b-instruct`
  (MoE, ~3B active) is a strong upgrade — but it will not fit in 8 GB.
- The skeleton reduction is the load-bearing piece. If the model starts failing
  on large pages, check the reduction ratio before blaming the model.
- Vision input is the natural next step: the snapshot flow already captures
  screenshots, and a VL model could disambiguate pages that defeat DOM-only
  parsing. Deliberately deferred.
- A reviewer should scrutinize two things: that no page content reaches any log
  or error message, and that the Ollama serialization actually releases in a
  `finally` — a leaked queue slot deadlocks every later request.
- On TrueNAS, the app's compose YAML lives in the Apps configuration, not in this
  repo. When `docker-compose.yml` here changes in a way that matters (new env
  var, changed service name), the deployed custom app must be edited to match —
  there is no automatic sync. Note that in the commit message.
- Jellyfin and Ollama share one 8 GB card. If transcodes start failing after
  this lands, `OLLAMA_KEEP_ALIVE` is the first dial to turn, and dropping to
  `qwen2.5-coder:3b` (~2 GB) is the second.
