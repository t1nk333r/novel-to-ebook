# 031 — Mistral as a selector-generation backend

- **Status**: DONE (2026-09-13)
- **Severity**: feature — the AI feature had no backend on hosts that cannot run the `ollama` sidecar
- **Depends on**: 022 (local Ollama backend)

## Why

Plan 022 gave selector generation a local backend, and left Gemini as the only
hosted one. On this workstation the `ollama` service cannot start at all — its
compose entry pins `runtime: nvidia` and the host has an AMD GPU — while
`docker-compose.yml` sets `OLLAMA_URL` for the whole stack, so auto-detection
picked a dead endpoint and every generation failed with a connection error.

The operator has a Mistral API key, so Mistral becomes the third backend. It is
the same shape of work as 022: a hosted endpoint, a compiled-in URL, no local
device to serialize on.

## What landed

- `src/lib/ai-provider.ts`: `resolveAiProvider` now resolves three backends, and
  `generateSelectorsWithMistral` posts to
  `https://api.mistral.ai/v1/chat/completions` with
  `response_format: { type: "json_object" }`, returning the parsed document for
  `SelectorSchema.parse` at the call site.
- `AI_PROVIDER` (`auto|ollama|gemini|mistral`) forces a backend. This is the part
  that makes the feature usable here: `OLLAMA_URL` is always set by the compose
  file, so detection alone cannot express "that sidecar does not run on this
  host".
- `NO_AI_PROVIDER_MESSAGE` is now defined once and used by both the route and
  `generateSelectors`; it was duplicated verbatim in two files, which is why the
  two copies would have drifted as backends were added.
- `.env.example`, `docker-compose.yml` and the README's AI section document the
  backend, the ordering, and the `AI_PROVIDER` escape hatch.

## Decisions

- **Auto-detection order stays local-first**: `ollama → gemini → mistral`. A
  self-hosted model should win over a billed API when both are configured, and
  keeping Gemini ahead of Mistral preserves existing setups. `AI_PROVIDER` is the
  explicit answer when the order is wrong for a host.
- **No SSRF policy on this URL**, matching the standing of `OLLAMA_URL` and the
  Gemini SDK call: the address is compiled in, never derived from a page. The
  policy exists for scraped URLs, which is also why `OLLAMA_URL` is validated by
  its own scheme/credential checks instead.
- **Mistral is not put through the local inference queue.** That queue exists to
  stop two generations thrashing one GPU; a remote endpoint has nothing to share
  but the general `MAX_AI_CONCURRENCY` bound.
- **Errors name the status and model only.** A rejected key must not appear in a
  log line, and an error body can echo page content — both are pinned by tests.

## Evidence

- `tests/ai-selectors.test.ts`: 11 new tests. The request shape (endpoint, model,
  `response_format`, non-streaming, bearer header), skeleton-not-raw-page,
  the 401 path not echoing the key, malformed and empty replies, and the
  resolution rules including `AI_PROVIDER=mistral` over a set `OLLAMA_URL`.
  31 tests in that file pass; full suite 167 pass / 0 fail, twice.
- Live against the Mistral API from the running container: `generate-selectors`
  against a real novel page's HTML, with `AI_PROVIDER=mistral` and the key read
  from `~/.config/storvi/mistral-key`. Pending the operator putting the key there;
  the unit tests stand on their own until then.

## Not done

- Translation still requires `GEMINI_API_KEY`. It is a separate feature with its
  own prompt, and extending the backend choice to it was not part of this change.
