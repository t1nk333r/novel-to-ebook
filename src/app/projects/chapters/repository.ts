import type { Page } from "puppeteer";
import {
  getProjectConfig,
  tryExtractContent,
  updateProjectConfig,
} from "../utils";
import { newBrowserPage } from "../../../lib/browser";
import db from "../../../db";
import { uuid, waitFor } from "../../../lib/utils";
import { importQueue } from "./context";
import { sql } from "kysely";

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
      let lastIndex = await getLastIndex(projectId);

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
          await db
            .insertInto("project_chapters")
            .values({
              projectId,
              index: ++lastIndex,
              title,
              content: res.content,
            })
            .execute();
          console.log("test");

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
      }

      ctx.setProgress(100, "Done");
    },
    { namespace: projectId },
  );
}

export async function getLastIndex(projectId: string) {
  const last = await db
    .selectFrom("project_chapters")
    .select(sql<number>`max("index")`.as("idx"))
    .where("projectId", "=", projectId)
    .executeTakeFirst();
  return last?.idx ?? -1;
}

export async function reorderChapters(projectId: string, ids: number[]) {
  const caseSql = sql`CASE id
    ${sql.join(
      ids.map((id, i) => sql`WHEN ${id} THEN ${i}`),
      sql` `,
    )}
  END`;

  const chapters = await db.selectFrom("project_chapters").select("id").where("projectId", "=", projectId).execute();
  const allowed = new Set(chapters.map((chapter) => chapter.id));
  if (ids.length !== chapters.length || new Set(ids).size !== ids.length || ids.some((id) => !allowed.has(id))) {
    throw new Error("Reorder ids must be unique chapters in this project");
  }
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("project_chapters").set({ index: sql`index + 1000000` as never }).where("projectId", "=", projectId).execute();
    await trx.updateTable("project_chapters").set({ index: caseSql as never }).where("projectId", "=", projectId).execute();
  });
}
