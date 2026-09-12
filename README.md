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
  for it) and/or restrict access with a Tailscale ACL or host firewall rule. For
  local-only use, change the mapping back to `127.0.0.1:3000:3000`.

## Configuration

Copy `.env.example` and set `DATA_PATH`, `PORT`, and (when binding `HOST` beyond
loopback) a strong `API_TOKEN`. Remote API requests must then send
`Authorization: Bearer <API_TOKEN>`.

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
