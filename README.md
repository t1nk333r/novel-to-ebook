# Storvi

Storvi is a self-hosted EPUB/PDF library, reader, and novel-to-ebook workspace.

## Requirements

- Node.js 24+
- pnpm 11.24+
- Bun 1.4+ (used for the server and tests)

## Development

```bash
pnpm install
pnpm dev
```

The API listens on `http://127.0.0.1:3000` by default and the Vite UI runs on its development port. Put EPUB/PDF files under `DATA_PATH` (default: `./data`) and use **Rescan** in the library.

## Verification and production

```bash
pnpm check
pnpm build
NODE_ENV=production bun run src/index.ts
```

`pnpm check` runs tests, server/UI typechecks, lint, and the production UI build.

## Docker

```bash
mkdir -p data          # put your EPUB/PDF files here
docker compose up -d --build
```

Storvi is then at `http://127.0.0.1:3000`. The image bundles Chromium for the
extraction pipeline, so no local Bun or Node install is needed.

- `./data` is bind-mounted read-write; EPUB exports land there and appear in the library.
  Make sure it is owned by you (`chown -R $USER:$USER data`) or exports fail with `EACCES`.
- The SQLite database lives on the `storvi-db` named volume, outside the image and outside your library folder.
- The port is published on **all interfaces** (`0.0.0.0:3000`), which makes it
  reachable over Tailscale and over any LAN the host has joined. Storvi has no
  user accounts, and its endpoints drive a headless browser and can spend AI
  quota, so set `API_TOKEN` in the container's environment (the UI will prompt
  for it) and/or restrict access with a Tailscale ACL or host firewall rule. An
  `API_TOKEN` supplied at `docker compose up` time stays with the container until
  it is recreated — recreate it with the variable exported, or it comes back
  unauthenticated. For local-only use, change the mapping back to
  `127.0.0.1:3000:3000`.

## Configuration

Copy `.env.example` and set `DATA_PATH`, `PORT`, and (when binding `HOST` beyond
loopback) a strong `API_TOKEN`. Remote API requests must then send
`Authorization: Bearer <API_TOKEN>`.

`.env.example` lists the rest: request/text/link ceilings and the two workload
ceilings, `MAX_BROWSER_CONCURRENCY` (default 3) and `MAX_AI_CONCURRENCY`
(default 2). Those two are enforced process-wide — a request that would exceed
them is refused with `429 WORKLOAD_LIMIT_REACHED` before any work starts, while
a queued chapter import waits for a free slot instead of failing. Raise them
only if the host has the RAM for the extra Chromium pages.

### Binding beyond loopback

`HOST` defaults to `127.0.0.1`. Any other value counts as remote and requires
either `API_TOKEN` or an explicit `ALLOW_INSECURE_BIND=1`:

| Setting | Effect |
|---|---|
| `HOST=127.0.0.1` | Local only. No token needed. |
| `HOST=0.0.0.0` + `API_TOKEN` | Authenticated. Every `/api` request needs the bearer token. |
| `HOST=0.0.0.0` + `ALLOW_INSECURE_BIND=1` | Unauthenticated. Startup logs a warning. |
| `HOST=0.0.0.0`, neither | Refuses to start. |

`ALLOW_INSECURE_BIND` exists for containers: a container must bind `0.0.0.0` to
be reachable at all, even when Docker publishes the port only to `127.0.0.1`. It
asserts that something *outside* the process — the published-port scope, or a
reverse proxy — restricts who can connect. It is not safe on a LAN or public
interface, and it never disables authentication: an `API_TOKEN` that is set is
still enforced.

### Using the UI with a token

The web UI sends `Authorization: Bearer <API_TOKEN>` on every `/api` request —
ordinary queries, SSE streams, cover images, and book downloads. The first 401
opens a prompt; paste the server's `API_TOKEN` and the page reloads
authenticated. The value is kept in that browser's `localStorage` under
`app/auth`, so it must be entered once per browser or device and again after
clearing site data. It is never attached to cross-origin requests.

Treat the token as device-scoped: any script running on the page can read
`localStorage`. Rotate it by changing `API_TOKEN` on the server, which
invalidates every stored copy.

### Outbound requests

Storvi fetches pages, images, and fonts that you point it at, and content it
scrapes can contain URLs of its own, so every server-side outbound request is
filtered: only `http:`/`https:`, no credentials in the URL, no `localhost`, and
no literal loopback/private/link-local address. Redirect targets are re-checked
and response sizes are capped.

Two limits are worth knowing:

- The browser is driven in-page, and the **document** it loads is checked at
  every hop including redirects, so a page cannot bounce Chromium into your
  network: a public URL answering `302 Location: http://169.254.169.254/` is
  refused before anything is rendered. Subresources it fetches — images, fonts,
  scripts, iframes — are **not** filtered, because filtering them measurably
  changes how real pages behave, and they are not what gets saved as a chapter.
- The EPUB export checks the **host** of each image URL, not what it resolves to
  (`file://` and internal addresses are refused; a public name pointing at a
  private address is not). That hook cannot do a DNS lookup without blocking the
  export.

Neither limit weakens the token boundary: the browser and the export are only
reachable by a token holder, and the exposure addressed here is what a page the
operator chose to fetch could otherwise do on its own.

### Importing a chapter

**One chapter.** Add → Link, paste the chapter URL, and optionally pick the
content with **Pick** (or type a selector). Save adds that single chapter.

**Every chapter a page loads.** Some readers append the following chapters as you
scroll — one URL can carry a dozen. Tick **"Import every chapter this page
loads"** in the same dialog and the server opens the page, scrolls until it stops
growing, and imports one chapter per match of the selector through the normal
import queue (so progress shows in the project sidebar).

**A whole book.** Add → **Whole book**, paste the book's URL, and give the content
selector once (pick it from any chapter with Add → Link → Pick). The server reads
the site's catalogue for the ordered chapter list, then loads reader pages and
takes every chapter each one renders, skipping chapters it has already imported.

That last part is what makes it practical: a 2,367-chapter novel imports in tens
of minutes, stops cleanly, and **resumes** where it left off when you submit it
again — progress is recorded per source chapter by id, not by title. Two caveats:
the task holds the browser for its whole run, so other browser-driven requests are
refused with 429 meanwhile, and the walk imports every entry the catalogue lists,
including author notes and side chapters, exactly as the site presents them.

Two things to know about that mode: a **selector is required** — each match
becomes a chapter, and the site above uses one container per chapter — and the
work is bounded by `MAX_SCROLL_LOADS` (default 12). Chapters taken this way are
read from the rendered page, so the Readability fallback that the single-chapter
flow applies does not run on them, and importing the same page twice will append
the chapters again.

### Local AI (Ollama)

Content selectors can be generated by a model instead of picked by hand. With
`OLLAMA_URL` set, generation runs **locally** — no page content leaves the
machine, and no API key is needed. Without it, `GEMINI_API_KEY` is used if
present, and the endpoint returns `503` if neither is configured.

The `ollama` service in `docker-compose.yml` is deliberately not published: it is
reachable only from Storvi over the compose network, because an open inference
endpoint can burn the GPU from anywhere on the network.

```bash
docker compose up -d --build
docker compose exec ollama ollama pull qwen2.5-coder:7b   # ~4.7 GB, one time
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi  # host GPU check
```

Things worth knowing:

- **AI parsing is opt-in.** It runs only when you ask for it from the UI; a
  snapshot never triggers it, so it cannot compete with other GPU work by
  itself.
- **`OLLAMA_KEEP_ALIVE` (5m by default) is the dial to watch on a shared GPU.**
  The standard deployment shares one card with Jellyfin transcoding; letting the
  model unload when idle costs a reload on the next request and keeps transcodes
  from stalling. On a dedicated card raise it to `30m` (`OLLAMA_KEEP_ALIVE` is
  set in `docker-compose.yml`).
- **8 GB is tight.** qwen2.5-coder:7b at Q4 is ~4.7 GB, so only a reduced
  skeleton of the page is sent, never the whole HTML
  (`MAX_AI_SKELETON_BYTES`, default 60000). If results get worse on large pages,
  check the reduction before blaming the model. `qwen2.5-coder:3b` (~2 GB) is the
  fallback for a busier card.
- **Requests are serialized.** Two concurrent generations on one 8 GB card would
  thrash, so the server queues them.

#### TrueNAS SCALE

TrueNAS is an appliance: its supported interfaces are the WebUI, CLI and API, and
containers created outside the Apps subsystem are unmanaged. Three consequences:

1. Deploy through **Apps → Discover Apps → Custom App → Install via YAML**,
   pasting this compose file — not `docker compose up` over SSH.
2. Keep **both services in one custom app**. Each app is its own compose project
   with its own network, so `http://ollama:11434` would not resolve and
   `depends_on` would not apply if they were separate apps.
3. **Bind-mount ZFS datasets** for `./data`, the SQLite store and the Ollama
   model store, rather than using the named volumes. The model dataset needs
   roughly 5 GB.

The compose file here is the source you adapt for that app; when it changes in a
way that matters (a new environment variable, a renamed service), the deployed
custom app has to be edited to match — there is no automatic sync.

