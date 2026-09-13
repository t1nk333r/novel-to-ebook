import fs from "fs/promises";
import path from "path";
import EPub from "epub";
import * as blurhash from "blurhash";
import sharp from "sharp";
import { pdfToImg } from "pdftoimg-js";
import db from "../../db";
import { limits } from "../../lib/limits";
import { mapWithConcurrency } from "../../lib/utils";

const supportExt = ["epub", "pdf"];

type CoverData = { data: Buffer; mimeType: string };

/** What a single book contributes, beyond what `stat` already tells us. */
type Enrichment = {
  metadata: Record<string, string>;
  cover: CoverData | null;
  coverHash: string | null;
};

type CacheEntry = Enrichment & { size: number; mtimeMs: number };

/**
 * Enrichment memo, keyed by absolute path and validated by size + mtime.
 *
 * In memory on purpose: a restart pays one cold scan, which is cheaper than a
 * cache schema and its migrations. Only *successful* enrichment is stored, so a
 * file that failed to parse is retried on the next scan.
 */
const enrichmentCache = new Map<string, CacheEntry>();

/** Injectable so tests can count parses without touching real books. */
export type FileEnricher = (fullPath: string) => Promise<Enrichment>;

export async function scanLibrary(
  paths: string[],
  opt?: { signal?: AbortSignal; enrich?: FileEnricher },
) {
  const { signal } = opt || {};
  const enrich = opt?.enrich ?? enrichFile;
  signal?.throwIfAborted();

  const readHistories = await db
    .selectFrom("histories")
    .select(["key", "date"])
    .execute()
    .then((rows) => {
      const histories: Record<string, number> = {};
      for (const row of rows) {
        histories[row.key] = new Date(row.date).getTime();
      }
      return histories;
    });

  signal?.throwIfAborted();

  const seen = new Set<string>();
  const items: LibraryItem[] = [];

  for (const p of paths) {
    signal?.throwIfAborted();
    const basePath = path.resolve(p);

    const entries = (
      await fs.readdir(p, { recursive: true, withFileTypes: true })
    ).filter((entry) => {
      // Reading-app metadata, not content: KOReader writes a `.sdr` folder beside
      // each book it opens, and the library was listing them as browsable items.
      const parent = (entry as { parentPath?: string; path?: string }).parentPath
        ?? (entry as { path?: string }).path
        ?? "";
      if (`${parent}/${entry.name}`.split("/").some((segment) => segment.toLowerCase().endsWith(".sdr"))) {
        return false;
      }
      if (entry.isDirectory()) return true;
      if (entry.isFile()) {
        const ext = entry.name.split(".").pop();
        return supportExt.includes(ext?.toLowerCase() ?? "");
      }
      return false;
    });

    const scanned = await mapWithConcurrency(
      entries,
      limits.scanConcurrency,
      async (entry) => readEntry({ entry, p, basePath, enrich, readHistories, seen }),
      signal,
    );

    items.push(...scanned);
  }

  signal?.throwIfAborted();
  rollUpDirectories(items);

  // Evict only from a scan that ran to completion: an aborted scan has an
  // incomplete view of the library and would drop live entries.
  if (!signal?.aborted) {
    for (const key of enrichmentCache.keys()) {
      if (!seen.has(key)) enrichmentCache.delete(key);
    }
  }

  return items;
}

type LibraryItem = {
  key: string;
  name: string;
  path: string;
  parent: string;
  fullPath: string;
  isDirectory: boolean;
  metadata: Record<string, string | number | null>;
  cover: string | null;
  coverHash: string | null;
  getCover?: () => Promise<CoverData>;
};

async function readEntry(input: {
  entry: { name: string; path?: string };
  p: string;
  basePath: string;
  enrich: FileEnricher;
  readHistories: Record<string, number>;
  seen: Set<string>;
}): Promise<LibraryItem> {
  const { entry, p, basePath, enrich, readHistories, seen } = input;

  const fullPath = path.join(entry.path ?? p, entry.name);
  const relative = path.relative(p, fullPath).replaceAll("\\", "/");
  const parentDir = path.dirname(relative).replaceAll("\\", "/");
  // "." is the scan root; anything else keeps its real name, dots included
  // (the previous pass stripped every dot, folding `vol.1/` into `vol1/`).
  const parent = parentDir === "." ? "" : parentDir;
  const key = relative;
  const stat = await fs.stat(fullPath);
  const isDirectory = stat.isDirectory();

  seen.add(fullPath);

  const cached = enrichmentCache.get(fullPath);
  const isUnchangedFile =
    !isDirectory &&
    cached !== undefined &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs;

  let enrichment: Enrichment;
  if (isDirectory) {
    enrichment = { metadata: {}, cover: null, coverHash: null };
  } else if (isUnchangedFile && cached) {
    enrichment = {
      metadata: cached.metadata,
      cover: cached.cover,
      coverHash: cached.coverHash,
    };
  } else {
    try {
      enrichment = await enrich(fullPath);
      enrichmentCache.set(fullPath, {
        ...enrichment,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch (err) {
      // Never memoize a failure: the next scan should try again.
      console.log("Err reading file!", entry.name, err);
      enrichment = { metadata: {}, cover: null, coverHash: null };
    }
  }

  const title = entry.name.split(".").slice(0, -1).join(".");
  const coverData = enrichment.cover;

  return {
    key,
    name: entry.name,
    path: basePath,
    parent,
    fullPath,
    isDirectory,
    metadata: {
      title,
      ...enrichment.metadata,
      created: stat.birthtimeMs,
      modified: stat.mtimeMs,
      readAt: readHistories[key] || null,
    },
    cover: coverData ? getCoverUrl(key) : null,
    coverHash: enrichment.coverHash,
    getCover: coverData ? () => Promise.resolve(coverData) : undefined,
  };
}

/**
 * Directory rows inherit the first child cover and the most recent child
 * readAt. One pass building two maps, where the previous version re-scanned the
 * whole result for every directory.
 */
function rollUpDirectories(items: LibraryItem[]) {
  const coverByParent = new Map<string, { key: string; cover: string }>();
  const readAtByParent = new Map<string, number>();

  for (const item of items) {
    if (item.isDirectory) continue;

    if (item.cover) {
      const current = coverByParent.get(item.parent);
      // Deterministic pick: `readdir` order can change between scans, and a
      // directory cover that flips on its own looks like a bug.
      if (!current || item.key < current.key) {
        coverByParent.set(item.parent, { key: item.key, cover: item.cover });
      }
    }

    const readAt = item.metadata.readAt;
    if (typeof readAt === "number") {
      const current = readAtByParent.get(item.parent);
      if (current === undefined || readAt > current) {
        readAtByParent.set(item.parent, readAt);
      }
    }
  }

  for (const item of items) {
    if (!item.isDirectory) continue;
    item.cover = coverByParent.get(item.key)?.cover ?? null;
    item.metadata.readAt = readAtByParent.get(item.key) ?? null;
  }
}

/** Parse one book: metadata, cover bytes, blur hash. */
async function enrichFile(fullPath: string): Promise<Enrichment> {
  let metadata: Record<string, string> = {};
  let cover: CoverData | null = null;
  let coverHash: string | null = null;

  if (fullPath.endsWith(".epub")) {
    const epub = new EPub(fullPath);
    await epub.parse();
    metadata = epub.metadata as never;

    const coverId = (epub.metadata as { cover?: string }).cover;
    if (coverId) {
      const image = await epub.getImage(coverId);
      cover = { data: await compressImage(image.data, 256), mimeType: "image/webp" };
      coverHash = await createBlurHash(image.data);
    }
  }

  if (fullPath.endsWith(".pdf")) {
    const coverImg = await pdfToImg(fullPath, {
      pages: "firstPage",
      imgType: "jpg",
    });
    const coverBuf = Buffer.from(
      coverImg.replace("data:image/jpeg;base64,", ""),
      "base64",
    );

    cover = { data: await compressImage(coverBuf, 256), mimeType: "image/webp" };
    coverHash = await createBlurHash(coverBuf);
  }

  return { metadata, cover, coverHash };
}

async function compressImage(image: Buffer, width: number) {
  return sharp(image)
    .resize({
      width,
      fit: sharp.fit.contain,
    })
    .webp({
      quality: 80,
    })
    .toBuffer();
}

async function createBlurHash(buf: Buffer) {
  const { data, info } = await sharp(buf)
    .raw()
    .ensureAlpha()
    .resize({ width: 32, fit: "contain" })
    .toBuffer({ resolveWithObject: true });

  return blurhash.encode(
    new Uint8ClampedArray(data),
    info.width,
    info.height,
    3,
    4,
  );
}

export type LibraryItems = Awaited<ReturnType<typeof scanLibrary>>;

export function getCoverUrl(key?: string | null) {
  if (!key) return null;
  return "/library/cover.jpeg?key=" + encodeURIComponent(key);
}
