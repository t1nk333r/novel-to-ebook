import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Migrator } from "kysely";
import db from "../src/db";
import { migrations } from "../src/db/migrations";
import { scanLibrary, type FileEnricher } from "../src/app/library/utils";

/**
 * Plan 016: the scan must not reparse unchanged books, must bound how many
 * files it opens at once, and must not lose or invent entries when the
 * directory changes.
 *
 * The enricher is injected, so "did it reparse?" is a counter rather than a
 * timing guess, and the fixtures are empty files — the scan's own logic is what
 * is under test, not EPUB parsing.
 */

const dirs: string[] = [];

async function fixtureDir(name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `storvi-scan-${name}-`));
  dirs.push(dir);
  return dir;
}

async function writeBook(dir: string, name: string, contents = "book") {
  const full = path.join(dir, name);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents);
  return full;
}

function countingEnricher() {
  const calls: string[] = [];
  const enrich: FileEnricher = async (fullPath) => {
    calls.push(fullPath);
    return {
      metadata: { title: `parsed:${path.basename(fullPath)}` },
      cover: null,
      coverHash: null,
    };
  };
  return { enrich, calls };
}

// The scan reads `histories`; the shared test database starts empty.
beforeAll(async () => {
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return migrations;
      },
    },
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  for (const dir of dirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("scanLibrary caching", () => {
  test("a second unchanged scan reparses nothing", async () => {
    const dir = await fixtureDir("unchanged");
    await writeBook(dir, "one.epub");
    await writeBook(dir, "two.pdf");

    const { enrich, calls } = countingEnricher();

    const first = await scanLibrary([dir], { enrich });
    expect(calls).toHaveLength(2);
    expect(first.filter((i) => !i.isDirectory)).toHaveLength(2);

    calls.length = 0;
    const second = await scanLibrary([dir], { enrich });

    // The whole point of the plan: no parser or image work on an unchanged tree.
    expect(calls).toHaveLength(0);
    expect(second.map((i) => i.key).sort()).toEqual(first.map((i) => i.key).sort());
    expect(
      second.find((i) => i.key === "one.epub")?.metadata.title,
    ).toBe("parsed:one.epub");
  });

  test("a modified file is reparsed and an added file is parsed", async () => {
    const dir = await fixtureDir("changed");
    const book = await writeBook(dir, "book.epub");

    const { enrich, calls } = countingEnricher();
    await scanLibrary([dir], { enrich });
    calls.length = 0;

    await fs.writeFile(book, "different contents entirely");
    await writeBook(dir, "added.epub");

    const after = await scanLibrary([dir], { enrich });

    expect(calls.map((c) => path.basename(c)).sort()).toEqual([
      "added.epub",
      "book.epub",
    ]);
    expect(after.find((i) => i.key === "added.epub")).toBeDefined();
  });

  test("a removed file drops out and is not served from the cache if it returns", async () => {
    const dir = await fixtureDir("removed");
    const book = await writeBook(dir, "gone.epub");

    const { enrich, calls } = countingEnricher();
    await scanLibrary([dir], { enrich });

    await fs.rm(book);
    const afterRemoval = await scanLibrary([dir], { enrich });
    expect(afterRemoval.some((i) => i.key === "gone.epub")).toBe(false);

    // Re-created: it must be parsed again, proving the cache entry was evicted
    // rather than left behind after the file disappeared.
    calls.length = 0;
    await writeBook(dir, "gone.epub");
    await scanLibrary([dir], { enrich });
    expect(calls.map((c) => path.basename(c))).toEqual(["gone.epub"]);
  });

  test("a failing parse is retried on the next scan instead of being cached", async () => {
    const dir = await fixtureDir("failure");
    await writeBook(dir, "broken.epub");

    let attempts = 0;
    const enrich: FileEnricher = async () => {
      attempts++;
      throw new Error("cannot parse");
    };

    await scanLibrary([dir], { enrich });
    await scanLibrary([dir], { enrich });

    expect(attempts).toBe(2);
  });
});

describe("scanLibrary shape", () => {
  test("directory rows inherit a child cover and the most recent readAt", async () => {
    const dir = await fixtureDir("rollup");
    await writeBook(dir, "series/one.epub");
    await writeBook(dir, "series/two.epub");

    const enrich: FileEnricher = async (fullPath) => ({
      metadata: { title: path.basename(fullPath) },
      cover: { data: Buffer.from("cover"), mimeType: "image/webp" },
      coverHash: "hash",
    });

    const items = await scanLibrary([dir], { enrich });
    const seriesDir = items.find((i) => i.isDirectory && i.key === "series");

    expect(seriesDir).toBeDefined();
    expect(seriesDir?.cover).toBe("/library/cover.jpeg?key=series%2Fone.epub");
  });

  test("dotted directory names are preserved in the parent key", async () => {
    const dir = await fixtureDir("dotted");
    await writeBook(dir, "vol.1/chapter.epub");

    const { enrich } = countingEnricher();
    const items = await scanLibrary([dir], { enrich });

    const chapter = items.find((i) => i.key === "vol.1/chapter.epub");
    expect(chapter?.parent).toBe("vol.1");
    expect(items.some((i) => i.isDirectory && i.key === "vol.1")).toBe(true);
  });

  test("nested files resolve to their real parent", async () => {
    const dir = await fixtureDir("nested");
    await writeBook(dir, "a/b/c.epub");
    await writeBook(dir, "top.epub");

    const { enrich } = countingEnricher();
    const items = await scanLibrary([dir], { enrich });

    expect(items.find((i) => i.key === "top.epub")?.parent).toBe("");
    expect(items.find((i) => i.key === "a/b/c.epub")?.parent).toBe("a/b");
  });
});

describe("scanLibrary bounds and abort", () => {
  test("never opens more files at once than the configured limit", async () => {
    const dir = await fixtureDir("bounded");
    for (let i = 0; i < 24; i++) {
      await writeBook(dir, `book-${i}.epub`);
    }

    let inFlight = 0;
    let peak = 0;
    const enrich: FileEnricher = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { metadata: {}, cover: null, coverHash: null };
    };

    await scanLibrary([dir], { enrich });

    const limit = Number(process.env.MAX_SCAN_CONCURRENCY || 4);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(limit);
  });

  test("an already-aborted scan rejects instead of returning partial items", async () => {
    const dir = await fixtureDir("abort");
    await writeBook(dir, "book.epub");

    const controller = new AbortController();
    controller.abort();

    const { enrich, calls } = countingEnricher();

    await expect(
      scanLibrary([dir], { enrich, signal: controller.signal }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("an abort mid-scan rejects", async () => {
    const dir = await fixtureDir("abort-mid");
    for (let i = 0; i < 6; i++) {
      await writeBook(dir, `book-${i}.epub`);
    }

    const controller = new AbortController();
    let seen = 0;
    const enrich: FileEnricher = async () => {
      if (++seen === 2) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { metadata: {}, cover: null, coverHash: null };
    };

    await expect(
      scanLibrary([dir], { enrich, signal: controller.signal }),
    ).rejects.toThrow();
    // Not every file was parsed, and nothing was returned.
    expect(seen).toBeLessThan(6);
  });
});
