# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build the production UI bundle.
#
# The UI build needs Node + pnpm (vite, tsc). Puppeteer must not download its
# bundled Chromium here: the runtime stage uses the distro package instead.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS builder

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# better-sqlite3 (kysely-codegen) compiles from source during install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

WORKDIR /app

# Manifests first so dependency resolution caches independently of source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ui/package.json ./ui/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Source, including the vendored foliate-js submodule content under ui/src/lib.
COPY . .

RUN pnpm --filter ui build && test -f ui/dist/index.html

# ---------------------------------------------------------------------------
# Stage 2 — runtime. Bun serves the API and the built UI.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4-debian AS runtime

# Chromium for Puppeteer, plus the font packages headless Chrome needs to
# render non-Latin book pages during extraction.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-core \
      fonts-noto-cjk \
      dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_PATH=/app/data \
    DATABASE_URL=/app/storage/storvi.sqlite

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/ui/dist ./ui/dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src ./src

# Library files and the SQLite database are bind/volume mounts, not image layers.
RUN mkdir -p /app/data /app/storage && chown -R bun:bun /app

USER bun
EXPOSE 3000

# dumb-init reaps the Chromium processes Puppeteer orphans on crash.
ENTRYPOINT ["dumb-init", "--"]
# Preflight mirrors the `prestart` script (pnpm is not present at runtime).
CMD ["sh", "-c", "bun run src/preflight.ts && exec bun run src/index.ts"]
