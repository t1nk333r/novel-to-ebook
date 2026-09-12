# Plan 026: Stop the EPUB exporter fetching arbitrary URLs

> **Executor instructions**: Confirm the dependency's behaviour with a real run
> before and after your change — the fix is small but it sits inside a
> third-party generator, so the evidence that matters is a generated EPUB. When
> done, update the status row for this plan in `plans/README.md` unless a
> reviewer told you they maintain the index.
>
> **Drift check**: `git diff --stat 04dfe0e..HEAD -- src/app/projects/routes.ts src/lib/network-policy.ts tests`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/005-safe-outbound-urls.md` (landed)
- **Category**: security
- **Planned at**: commit `04dfe0e`, 2026-09-12

## Why this matters

Chapter content is captured from pages the operator does not control, sanitized
so `<img src=…>` survives, and later handed to `@epubkit/epub-gen-memory` at
export time. That generator fetches every image URL it finds — and for a
`file://` URL it reads the local filesystem directly:

```js
if (url.startsWith('file://')) return fs.readFile(new URL(url), ...);
// otherwise node-fetch(url), with no host or scheme restriction
```

So a hostile page can put `<img src="file:///home/<user>/.ssh/id_rsa">` or an
internal URL into a chapter, and the bytes end up inside the `.epub` the
operator downloads and shares. That is a stronger primitive than a bare SSRF:
the data leaves the machine as an artifact. The route already passes
`ignoreFailedDownloads: true`, so dropping a URL is safe rather than fatal.

## Current state

- `src/app/projects/routes.ts` — the export route builds the book with
  `EpubGenMemory({ …, imageTransformer(image) { … } }, contents)`; the hook
  currently only rewrites protocol-relative URLs:

  ```ts
  imageTransformer(image) {
    if (image.url.startsWith("//")) {
      image.url = "https:" + image.url;
    }
    return image;
  }
  ```

- `node_modules/@epubkit/epub-gen-memory/dist/lib/util/fetchable.js` — the
  `file://` branch and the unrestricted `node-fetch` call.
- `src/lib/network-policy.ts` — `isPublicIp(address)` is sync and exported;
  `safeFetch` is async. The transformer hook is synchronous, so the practical
  filter here is scheme + userinfo + literal-IP checks, not a DNS lookup.
- Stored content reaches the generator through `POST /projects/:id/export`
  (`src/app/projects/routes.ts`), which reads `project_chapters.content` — the
  rows written by the import worker.

## Commands you will need

```bash
export PATH="$HOME/.local/share/mise/installs/bun/1.4.0/bin:$PATH"
pnpm install --frozen-lockfile --ignore-scripts
```

| Purpose | Command | Expected |
|---|---|---|
| Server | `HOST=127.0.0.1 PORT=3012 DATABASE_URL=/tmp/export.sqlite DATA_PATH=./data bun run src/index.ts` | `Listening on` |
| Export a project | `curl -s -X POST http://127.0.0.1:3012/api/projects/<id>/export` | `{"key":"…"}` |
| Inspect the artefact | `unzip -l data/exports/*.epub` | lists entries, no embedded local file |
| Tests | `pnpm test` | all pass |

## Scope

**In scope**: the export route's `imageTransformer` in
`src/app/projects/routes.ts`; a small exported predicate (in
`src/lib/network-policy.ts` only if it fits that module's purpose, otherwise
beside it); `tests/`; README security notes if you add a new refusal.

**Out of scope**: patching `node_modules`; forking the generator; the
navigation-interception work in plan 024; changing `cleanHTML`'s allowed
attributes (a `file:` URL in stored content is not itself the defect — fetching
it is).

## Steps

### Step 1: Prove it end to end, first

Create a project with one chapter whose content contains an `<img>` pointing at a
local file and one pointing at an internal address (`http://127.0.0.1:3012/`),
then export it and inspect the EPUB:

```bash
unzip -l data/exports/<file>.epub
unzip -p data/exports/<file>.epub | head -c 200   # whichever entry you expect
```

Record what the generator actually did with each URL — it may embed the bytes, a
placeholder, or drop the image, and the fix depends on which. **If nothing is
fetched in your run, stop and report**: the finding is then wrong and the plan
should be closed rather than implemented.

**Verify**: a before-export listing showing the local file's contents embedded
(or a clear statement that it is not).

### Step 2: Filter in the transformer

Rewrite the hook so a URL survives only if it is `http:`/`https:`, carries no
userinfo, and its literal host is not a private/loopback/link-local address
(use the sync `isPublicIp` for literal IPs, and reject `localhost` and
`*.localhost` the way `isPublicIp`'s callers do). Anything else must be dropped
the way the generator already drops failed downloads — returning a falsy value
or an empty URL, whichever the dependency's contract actually supports; confirm
which by reading its source and by generating an EPUB in the same step.

Keep the existing `//` → `https:` normalisation: it runs first, and the filter
must see the normalised URL.

Log each refused URL at `console.warn` with the URL's origin only — never the
local path, and never file contents.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Re-run the export proof

Repeat step 1 on the same fixture. The local-file and loopback images must not
appear in the archive, and an ordinary public `https://` image must still be
embedded — keep one in the fixture so you can show the fix did not simply
disable images.

**Verify**: an after-export listing for both cases.

### Step 4: Test and gates

Add a test for the predicate (no network, no browser): public https allowed;
`file:`, `data:`, `http://127.0.0.1`, `http://localhost`, a private IP, a
link-local IP, and a URL with userinfo all refused; a protocol-relative URL
still normalised. Put it in the existing security test file if it fits, since
this is the same policy family.

**Verify**: `pnpm test` → all pass; `pnpm lint` → 0 errors; `pnpm build` → exit 0.

## Done criteria

- [ ] A before/after export comparison exists for a local-file URL and a public URL.
- [ ] `grep -n "file:" src/app/projects/routes.ts` shows the filter, not a comment.
- [ ] The new predicate has tests, and they fail if the filter is removed.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` clean.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- The generator does not fetch these URLs at all in your run (the finding is
  then unreproduced — close the plan instead).
- Making the filter work requires patching or forking the dependency.
- The generator treats a dropped image as a hard failure despite
  `ignoreFailedDownloads: true`.

## Maintenance notes

- This filter is a literal-address check, not a DNS check: a hostname that
  resolves to a private address at export time still passes. Export happens at
  the operator's request on content they already imported, which is why that
  residual gap is accepted here — revisit it if exports ever become automatic or
  reachable by another party.
- `cleanHTML` allowing `<img src>` is deliberate (novel chapters are image-
  bearing). Do not tighten it to fix this; fix the fetch.
