import type { Page } from "puppeteer";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { suggestContentSelector } from "../selector-suggest";
import {
  collectScrolledChapters,
  getCleanHTML,
  getProjectConfig,
  stripSiteChrome,
  tryExtractContent,
  updateProjectConfig,
} from "../utils";
import { newBrowserPage } from "../../../lib/browser";
import { browserExecutor } from "../../../lib/bounded-executor";
import { HTTPError } from "../../../lib/error";
import { FontDecryptor } from "../../../lib/font-decryptor";
import { assertSafeOutboundUrl } from "../../../lib/network-policy";
import db from "../../../db";
import type { DB } from "../../../db/types";
import { cleanHTML, uuid, waitFor } from "../../../lib/utils";
import { importQueue } from "./context";
import {
  cleanImportedTitle,
  firstUnimportedIndex,
  parseCatalogChapters,
  type CatalogChapter,
} from "../book-import";

// A walk that keeps failing is a wrong selector or a site that has started
// refusing us; five in a row is enough to stop and say so rather than grind
// through two thousand dead pages.
const MAX_CONSECUTIVE_WALK_FAILURES = 5;

// Belt-and-suspenders retries on top of the (projectId,index) unique index:
// the shared connection mutex already serializes every transaction in this
// process, so a genuine race here should be extremely rare, but we still
// want a clean recovery path rather than surfacing a raw constraint error.
const MAX_INDEX_ALLOCATION_ATTEMPTS = 5;

function isChapterIndexConflict(err: unknown) {
  return (
    err instanceof Error &&
    err.message.includes("UNIQUE constraint failed") &&
    err.message.includes("project_chapters")
  );
}

export async function getLastIndex(
  projectId: string,
  executor: Kysely<DB> = db,
) {
  const last = await executor
    .selectFrom("project_chapters")
    .select(sql<number>`max("index")`.as("idx"))
    .where("projectId", "=", projectId)
    .executeTakeFirst();
  return last?.idx ?? -1;
}

/**
 * Allocates the next chapter index and inserts the chapter inside a single
 * serialized transaction, so manual creates and imports can never read the
 * same "last index" before either one has committed. Retries if a concurrent
 * writer still manages to collide on the unique (projectId,index) index.
 */
export async function insertChapterAtNextIndex(
  projectId: string,
  data: { title: string; content: string },
) {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_INDEX_ALLOCATION_ATTEMPTS; attempt++) {
    try {
      return await db.transaction().execute(async (trx) => {
        const index = (await getLastIndex(projectId, trx)) + 1;
        return trx
          .insertInto("project_chapters")
          .values({ ...data, projectId, index })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
    } catch (err) {
      if (isChapterIndexConflict(err)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

export function queueImportChapters(payload: {
  projectId: string;
  links: { url: string; title: string }[];
  delayMs?: number;
}) {
  const { projectId, links } = payload;

  return importQueue.add(
    async (ctx) => {
      let page: Page | null = null;
      let fontDecryptMap = projectId
        ? await getProjectConfig(projectId).then((i) => i.fontDecryptMap)
        : null;
      let progress = 0;

      // Background work waits for a browser slot instead of failing: a 429
      // here would abandon an import the operator explicitly queued.
      const releaseBrowser = await browserExecutor.acquire();

      try {
        page = await newBrowserPage();
        await page.setViewport({ width: 640, height: 480 });

        for (const { url, title } of links) {
          ctx.setProgress(
            (progress / links.length) * 100,
            `Extracting ${title}...`,
          );

          const res = await tryExtractContent(page, url, { fontDecryptMap });
          console.log("inserting...", res.title || title);
          await insertChapterAtNextIndex(projectId, {
            title,
            content: res.content,
          });

          if (res.hasNewDecryptMap) {
            fontDecryptMap = res.fontDecryptMap;
            await updateProjectConfig(projectId, { fontDecryptMap });
          }

          ctx.setProgress((progress++ / links.length) * 100);

          if (payload.delayMs) {
            await waitFor(payload.delayMs);
          }
        }

        console.log("Done");
      } catch (err) {
        console.error(err);
        throw err;
      } finally {
        if (page) await page.close();
        releaseBrowser();
      }

      ctx.setProgress(100, "Done");
    },
    { namespace: projectId },
  );
}

/**
 * Import every chapter a reader page loads as it is scrolled.
 *
 * Unlike `queueImportChapters`, nothing is re-fetched per chapter: the page has
 * already rendered each one, so the DOM is read directly. That is both faster
 * and the only reliable way to reach chapters a site exposes solely through
 * scrolling.
 *
 * Chapters captured this way do not go through `tryExtractContent`, so the
 * Readability/selector fallbacks do not apply — the caller's selector decides
 * what a chapter is. The project's font map is still applied, and a newly
 * detected map is persisted, matching the link importer.
 */
export function queueImportScrolledChapters(payload: {
  projectId: string;
  url: string;
  selector: string | string[];
  framePath?: string[] | null;
  maxScrolls?: number;
}) {
  const { projectId, url, selector, framePath, maxScrolls } = payload;

  return importQueue.add(
    async (ctx) => {
      let page: Page | null = null;
      const releaseBrowser = await browserExecutor.acquire();

      try {
        await assertSafeOutboundUrl(url);
        page = await newBrowserPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

        ctx.setProgress(5, "Loading chapters from the page...");

        const found = await collectScrolledChapters(page, selector, {
          framePath,
          maxScrolls,
        });

        if (found.length === 0) {
          throw new Error(
            "No chapters matched on that page — pick the content selector again, or import the chapters as links",
          );
        }

        if (!selector) {
          // Only reachable when the catalogue was already complete, which the
          // early return above handles; kept so the loop below has a string.
          ctx.setProgress(100, "Nothing to import");
          return;
        }

        let fontDecryptMap = await getProjectConfig(projectId).then(
          (config) => config.fontDecryptMap ?? null,
        );
        let index = 0;

        for (const chapter of found) {
          ctx.setProgress(
            (index / found.length) * 100,
            `Saving ${chapter.title ?? `chapter ${index + 1}`}...`,
          );

          const cleaned = cleanHTML(stripSiteChrome(chapter.html).html);
          if (!cleaned.trim()) {
            index++;
            continue;
          }

          let content = cleaned;
          if (fontDecryptMap) {
            content = FontDecryptor.fromMap(fontDecryptMap).decrypt(content);
          }

          const title =
            chapter.title || `Chapter ${(await getLastIndex(projectId)) + 1}`;

          await insertChapterAtNextIndex(projectId, { title, content });
          index++;
        }

        ctx.setProgress(100, `Imported ${index} chapter(s)`);
      } catch (err) {
        console.error(err);
        throw err;
      } finally {
        if (page) await page.close();
        releaseBrowser();
      }
    },
    { namespace: projectId },
  );
}

/**
 * Import a whole book: the catalogue supplies the ordered chapter list, reader
 * pages supply the content, and progress is recorded by source chapter id so a
 * run resumes where it stopped.
 *
 * Each reader page renders several chapters (the site appends them as you
 * scroll), so one page load usually completes a whole run of chapters and the
 * walk simply jumps to the next entry the project is still missing.
 */
export function queueImportBook(payload: {
  projectId: string;
  bookUrl: string;
  /** Omitted (or null) means "work it out": see the auto-selector step below. */
  selector?: string | string[] | null;
  framePath?: string[] | null;
  maxScrolls?: number;
  maxChapters?: number;
}) {
  const { projectId, bookUrl, framePath, maxScrolls, maxChapters } = payload;
  let selector = payload.selector;

  return importQueue.add(
    async (ctx) => {
      let page: Page | null = null;
      const releaseBrowser = await browserExecutor.acquire();

      try {
        await assertSafeOutboundUrl(bookUrl);
        page = await newBrowserPage();
        await page.setViewport({ width: 1280, height: 800 });

        ctx.setProgress(2, "Reading the chapter list...");
        const chapters = await readCatalog(page, bookUrl);

        if (chapters.length === 0) {
          throw new Error(
            "No chapters found on that page — pass the book's catalogue URL, or the book page that links to it",
          );
        }

        const importedIds = readImportedIds(await getProjectConfig(projectId));
        let index = firstUnimportedIndex(chapters, importedIds);

        // No selector supplied: measure one against a real chapter page before
        // walking anything. A wrong guess is not a small error — it is a
        // catalogue's worth of navigation links, or of empty chapters, found
        // hours later — so the heuristic is tried first and the model second,
        // and neither is trusted until it has been scored.
        if (!selector && index >= 0) {
          const first = chapters[index] as CatalogChapter;
          ctx.setProgress(3, `Looking for the chapter selector on ${first.title.slice(0, 30)}...`);

          await page.goto(first.url, { waitUntil: "networkidle2", timeout: 30000 });
          const suggested = await suggestContentSelector(await page.content(), {
            useModel: true,
          });

          if (!suggested) {
            throw new Error(
              "Could not work out a content selector for that site — open a chapter, pick the content (Add → Link → Pick), and import the whole book with that selector",
            );
          }

          selector = suggested.selector;
          ctx.setProgress(
            5,
            `Using ${suggested.selector} (${suggested.source}: ${suggested.score.reason})`,
          );
        }

        if (index < 0) {
          ctx.setProgress(100, "Already imported");
          return;
        }

        if (!selector) {
          // Only reachable when the catalogue was already complete, which the
          // early return above handles; kept so the loop below has a string.
          ctx.setProgress(100, "Nothing to import");
          return;
        }

        let fontDecryptMap = await getProjectConfig(projectId).then(
          (config) => config.fontDecryptMap ?? null,
        );
        let inserted = 0;
        const limit = maxChapters ?? chapters.length;

        // Pages that failed this run: skipped, not marked imported, so a later
        // run picks them up. Without this a single transient network error ended
        // a two-hour walk — one `net::ERR_NETWORK_CHANGED` cost 1,273 chapters.
        const skipped = new Set<string>();
        const done = () => new Set([...importedIds, ...skipped]);
        let consecutiveFailures = 0;

        const abandon = (chapter: CatalogChapter, reason: string) => {
          skipped.add(chapter.id);
          consecutiveFailures++;
          console.warn(`walk: skipping "${chapter.title.slice(0, 60)}" — ${reason}`);

          if (consecutiveFailures >= MAX_CONSECUTIVE_WALK_FAILURES) {
            throw new Error(
              `Stopped after ${consecutiveFailures} pages failed in a row (last: ${reason}). Submit again to resume from here.`,
            );
          }

          index = firstUnimportedIndex(chapters, done());
        };

        while (index >= 0 && inserted < limit) {
          const target = chapters[index] as CatalogChapter;
          ctx.setProgress(
            (index / chapters.length) * 100,
            `Loading from ${target.title.slice(0, 40)}...`,
          );

          let found: Awaited<ReturnType<typeof collectScrolledChapters>>;

          try {
            await page.goto(target.url, {
              waitUntil: "networkidle2",
              timeout: 30000,
            });
            found = await collectScrolledChapters(page, selector, {
              framePath,
              maxScrolls,
            });
          } catch (err) {
            abandon(target, err instanceof Error ? err.message : String(err));
            continue;
          }

          // The page renders this chapter and the ones after it; match them back
          // to the list by source id and keep the order the catalogue defines.
          const byId = new Map(
            found
              .map((chapter) => [chapter.id, chapter] as const)
              .filter((entry): entry is [string, (typeof found)[number]] =>
                Boolean(entry[0]),
              ),
          );

          if (byId.size === 0) {
            abandon(target, "nothing on the page matched the selector");
            continue;
          }

          consecutiveFailures = 0;

          for (const [id, chapter] of byId) {
            if (importedIds.has(id)) continue;
            if (inserted >= limit) break;

            const cleaned = cleanHTML(stripSiteChrome(chapter.html).html);
            if (!cleaned.trim()) continue;

            let content = cleaned;
            if (fontDecryptMap) {
              content = FontDecryptor.fromMap(fontDecryptMap).decrypt(content);
            }

            const catalogEntry = chapters.find((entry) => entry.id === id);
            await insertChapterAtNextIndex(projectId, {
              title: cleanImportedTitle(chapter.title ?? catalogEntry?.title ?? "Untitled"),
              content,
            });

            importedIds.add(id);
            inserted++;
          }

          await updateProjectConfig(projectId, {
            importedChapterIds: [...importedIds],
          });

          index = firstUnimportedIndex(chapters, done());
          ctx.setProgress(
            (index < 0 ? 1 : index / chapters.length) * 100,
            `${inserted} imported${skipped.size ? `, ${skipped.size} skipped` : ""}`,
          );
        }

        ctx.setProgress(
          100,
          `Imported ${inserted} chapter(s)${skipped.size ? `, skipped ${skipped.size} — submit again to retry them` : ""}`,
        );
      } catch (err) {
        console.error(err);
        throw err;
      } finally {
        if (page) await page.close();
        releaseBrowser();
      }
    },
    { namespace: projectId },
  );
}

/** The import ledger, validated: the config column is JSON written over time. */
function readImportedIds(config: { importedChapterIds?: unknown }) {
  const ids = config.importedChapterIds;

  return new Set<string>(
    Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string")
      : [],
  );
}

/**
 * The chapter list: the catalogue's, when there is one.
 *
 * The book page carries its own preview of chapters — a real bug came from
 * taking those links: the preview is shorter than the novel, so a resumed run
 * saw "everything imported" and stopped while 2,350 chapters were still
 * missing. The catalogue is the authority, and the book page is only a signpost
 * to it.
 */
async function readCatalog(page: Page, url: string) {
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  const isCatalog = /\/catalog\/?$/i.test(new URL(url).pathname);
  const catalogUrl = isCatalog ? url : await findCatalogLink(page);

  if (catalogUrl && catalogUrl !== url) {
    await page.goto(catalogUrl, { waitUntil: "networkidle2", timeout: 30000 });
  }

  const html = await page.evaluate(getCleanHTML);

  return parseCatalogChapters(html, catalogUrl ?? url);
}

/** The book page links its catalogue; that link is the whole chapter list. */
async function findCatalogLink(page: Page) {
  return page.evaluate(() => {
    const link = Array.from(document.querySelectorAll("a[href]")).find((a) =>
      /\/catalog\/?$/i.test(a.getAttribute("href") ?? ""),
    );

    return link ? (link as HTMLAnchorElement).href : null;
  });
}

export async function reorderChapters(projectId: string, ids: number[]) {
  const caseSql = sql`CASE id
    ${sql.join(
      ids.map((id, i) => sql`WHEN ${id} THEN ${i}`),
      sql` `,
    )}
  END`;

  await db.transaction().execute(async (trx) => {
    // Read and validate inside the transaction: the background importer
    // inserts chapters continuously, so a list validated outside it can be
    // stale by the time the updates run, and a row missing from the CASE has
    // no ELSE branch — it would take NULL and abort on the NOT NULL
    // constraint, losing the operator's reorder to a 500.
    const chapters = await trx
      .selectFrom("project_chapters")
      .select("id")
      .where("projectId", "=", projectId)
      .execute();
    const allowed = new Set(chapters.map((chapter) => chapter.id));
    if (
      ids.length !== chapters.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !allowed.has(id))
    ) {
      throw new HTTPError(
        "Chapter list is out of date, reload the table of contents",
        { status: 409, code: "STALE_CHAPTER_LIST" },
      );
    }

    await trx
      .updateTable("project_chapters")
      .set({ index: sql`"index" + 1000000` as never })
      .where("projectId", "=", projectId)
      .execute();
    await trx
      .updateTable("project_chapters")
      .set({ index: caseSql as never })
      .where("id", "in", ids)
      .execute();
  });
}
