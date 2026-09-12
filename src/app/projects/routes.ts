import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { translate, uuid, waitFor } from "../../lib/utils";
import {
  ActionSchema,
  contentSelectorList,
  CreateProjectReqSchema,
  CreateProjectResSchema,
  ProjectSchema,
  SnapshotRequestSchema,
  TranslateRequestSchema,
  TranslateResponseSchema,
  UpdateProjectReqSchema,
} from "./schema";
import { execActions, newBrowserPage } from "../../lib/browser";
import { browserExecutor } from "../../lib/bounded-executor";
import type { Page } from "puppeteer";
import { openApi } from "hono-zod-openapi";
import { HTTPException } from "hono/http-exception";
import z from "zod";
import {
  extractElements,
  fetchImage,
  findContentSelector,
  getCleanHTML,
  getProjectConfig,
  tryExtractContent,
  updateProjectConfig,
} from "./utils";
import EpubGenMemory from "@epubkit/epub-gen-memory";
import { rescanLibrary } from "../library/context";
import path from "path";
import db from "../../db";
import chapters from "./chapters/routes";
import { HTTPError } from "../../lib/error";
import { resolveExportDestination } from "../../lib/export-path";
import { limits } from "../../lib/limits";
import { assertSafeOutboundUrl } from "../../lib/network-policy";
import fs from "fs";
import type { ProjectConfig } from "./types";
import {
  startPeriodicTask,
  type PeriodicTaskStop,
} from "../../lib/periodic-task";

const router = new Hono();

// Sub routes
router.route("/:projectId/chapters", chapters);

// Create new project
router.post(
  "/",
  openApi({
    tags: ["Projects"],
    summary: "Create new project",
    request: { json: CreateProjectReqSchema },
    responses: { 200: CreateProjectResSchema },
  }),
  async (c) => {
    const body = c.req.valid("json");

    const res = await db
      .insertInto("projects")
      .values({ ...body, id: uuid() })
      .returning("id")
      .executeTakeFirstOrThrow();

    return c.var.res(res);
  },
);

// List project
router.get(
  "/",
  openApi({
    tags: ["Projects"],
    summary: "List projects",
    responses: { 200: z.array(ProjectSchema) },
  }),
  async (c) => {
    const res = await db
      .selectFrom("projects")
      .selectAll()
      .orderBy("updatedAt", "desc")
      .execute();
    return c.var.res(res.map((project) => ({
      ...project,
      config: project.config ? JSON.parse(project.config) : null,
    })));
  },
);

// Get project
router.get(
  "/:id",
  openApi({
    tags: ["Projects"],
    summary: "Get project by id",
    request: { param: z.object({ id: z.string() }) },
    responses: { 200: ProjectSchema },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const res = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    return c.var.res({
      ...res,
      config: res.config ? JSON.parse(res.config) : null,
    });
  },
);

// Delete project
router.delete(
  "/:id",
  openApi({
    tags: ["Projects"],
    summary: "Delete project",
    request: { param: z.object({ id: z.string() }) },
    responses: { 204: { description: "No content" } },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    await db.deleteFrom("projects").where("id", "=", id).execute();
    return c.body(null, 204);
  },
);

// Update project
router.put(
  "/:id",
  openApi({
    tags: ["Projects"],
    summary: "Update project",
    request: {
      param: z.object({ id: z.string() }),
      json: UpdateProjectReqSchema,
    },
    responses: { 200: ProjectSchema },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const values = c.req.valid("json");

    // Partial config update
    let mergedConfig = values.config;
    if (values.config) {
      const curData = await db
        .selectFrom("projects")
        .select("config")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const curConfig = curData.config ? JSON.parse(curData.config) : null;
      mergedConfig = { ...(curConfig || {}), ...values.config };
    }

    const dbValues = { ...values, config: mergedConfig ? JSON.stringify(mergedConfig) : mergedConfig };
    const res = await db
      .updateTable("projects")
      .set(dbValues)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return c.var.res({
      ...res,
      config: mergedConfig || null,
    });
  },
);

// Extract content from url
router.post(
  "/extract",
  openApi({
    tags: ["Projects"],
    summary: "Extract content from url",
    request: {
      json: z.object({
        projectId: z.string().nullish(),
        url: z.url(),
        selector: contentSelectorList.nullish(),
      }),
    },
    responses: {
      200: z.object({
        title: z.string(),
        chapter: z.string(),
        author: z.string(),
        content: z.string(),
        language: z.string(),
        isObfuscated: z.boolean().nullish(),
        fonts: z.string().array(),
      }),
    },
  }),
  async (c) => {
    const { projectId, url, selector } = c.req.valid("json");

    return browserExecutor.run(async () => {
      let page: Page | null = null;

      try {
        page = await newBrowserPage();
        await page.setViewport({ width: 640, height: 480 });

        const fontDecryptMap = projectId
          ? await getProjectConfig(projectId).then((i) => i.fontDecryptMap)
          : null;

        const res = await tryExtractContent(page, url, {
          fontDecryptMap,
          selector,
        });

        if (res.hasNewDecryptMap && projectId) {
          await updateProjectConfig(projectId, {
            fontDecryptMap: res.fontDecryptMap,
          });
        }

        return c.var.res({ ...res, fonts: [...res.fonts] });
      } catch (err) {
        console.error(err);
        throw new HTTPError("Error extracting content", { status: 400 });
      } finally {
        if (page) await page.close();
      }
    });
  },
);

router.post(
  "/:id/export",
  openApi({
    tags: ["Projects"],
    summary: "Export project",
    request: {
      param: z.object({ id: z.string() }),
    },
    responses: {
      200: z.object({ key: z.string() }),
    },
  }),
  async (c) => {
    let cover: string | undefined = undefined;

    try {
      const { id } = c.req.valid("param");
      const project = await db
        .selectFrom("projects")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      const config = project.config
        ? (JSON.parse(project.config) as ProjectConfig)
        : null;

      const chapters = await db
        .selectFrom("project_chapters")
        .selectAll()
        .where("projectId", "=", id)
        .execute();

      const contents = chapters.map((c) => ({
        title: c.title,
        content: c.content,
      }));

      const destination = await resolveExportDestination(
        process.env.DATA_PATH || "./data",
        project.title,
        config?.outDir,
      );
      const { fullPath, key } = destination;

      cover = project.cover
        ? (await fetchImage(project.cover, "./img"))?.fullPath
        : undefined;
      const epub = await EpubGenMemory(
        {
          title: project.title,
          author: project.author,
          cover,
          lang: project.language || "en",
          ignoreFailedDownloads: true,
          tocInTOC: true,
          imageTransformer(image) {
            if (image.url.startsWith("//")) {
              image.url = "https:" + image.url;
            }
            return image;
          },
        },
        contents,
      );

      fs.writeFileSync(fullPath, epub);
      setTimeout(rescanLibrary, 1000);

      return c.var.res({ key });
    } catch (err) {
      throw err;
    } finally {
      if (cover) fs.unlinkSync(cover);
    }
  },
);

// Get web snapshot and elements
router.post(
  "/snapshot",
  openApi({
    tags: ["Projects"],
    summary: "Get web snapshot and elements",
    request: {
      json: SnapshotRequestSchema,
    },
    responses: {
      200: { schema: z.null(), mediaType: "text/event-stream" },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const { url, width, height, isFullPage, actions } = body;

    // Acquired before the stream opens so saturation answers 429 instead of
    // an SSE error event after the response has already committed to 200.
    const releaseBrowser = browserExecutor.tryAcquire();

    return streamSSE(c, async (s) => {
      let page: Page | null = null;
      let stopScreenshots: PeriodicTaskStop | null = null;

      try {
        page = await newBrowserPage();

        const pageSize = {
          width: Math.min(Number(width) || 1280, limits.viewportDimension),
          height: Math.min(Number(height) || 800, limits.viewportDimension),
        };

        await page.setViewport(pageSize);
        await assertSafeOutboundUrl(url);
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

        const sendScreenshot = async (quality = 20, fullPage = false) => {
          if (!page) return;

          const fullPageSize = await page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
          }));
          pageSize.height = Math.min(fullPageSize.height, pageSize.height, 2400);

          if (fullPage) {
            await page.evaluate(() => window.scrollTo(0, 0));
            pageSize.height = Math.min(fullPageSize.height, limits.viewportDimension);
          }

          const screenshot = await page.screenshot({
            encoding: "base64",
            type: "jpeg",
            quality,
            fullPage,
          });

          await s.writeSSE({
            event: "screenshot",
            data: JSON.stringify({
              img: screenshot,
              width: pageSize.width,
              height: pageSize.height,
            }),
          });
        };

        if (body.blockList && body.blockList.length > 0) {
          await page.evaluate((list) => {
            for (const selector of list) {
              const elements = document.querySelectorAll(selector);
              for (const el of elements) {
                el.remove();
              }
            }
          }, body.blockList);
        }

        if (actions) {
          await sendScreenshot();

          stopScreenshots = startPeriodicTask(() => sendScreenshot(), 250);
          const acts = ActionSchema.array().parse(actions);
          await execActions(page, acts);
        }

        await stopScreenshots?.();
        stopScreenshots = null;
        await sendScreenshot(70, isFullPage);

        // Projects element tree for selector building
        const elements = await page.evaluate(
          extractElements,
          body.ignoreDuplicates,
        );
        const html = await page.evaluate(getCleanHTML);
        const contentSelector = findContentSelector(html)?.selector || null;

        s.writeSSE({
          event: "result",
          data: JSON.stringify({
            elements,
            url,
            pageSize,
            html,
            contentSelector,
          }),
        });
      } catch (err) {
        await s.writeSSE({
          event: "error",
          data: JSON.stringify({ message: (err as Error).message }),
        });
      } finally {
        await stopScreenshots?.();
        if (page) await page.close();
        releaseBrowser();
      }
    });
  },
);

// Translate content
router.post(
  "/translate",
  openApi({
    tags: ["Projects"],
    summary: "Translate content",
    request: {
      json: TranslateRequestSchema,
    },
    responses: {
      200: TranslateResponseSchema,
    },
  }),
  async (c) => {
    const { text, to = "en" } = c.req.valid("json");
    if (!text) {
      throw new HTTPException(400, { message: "text is required" });
    }

    const result = await translate(text, to);
    return c.json({ result });
  },
);

export default router;
