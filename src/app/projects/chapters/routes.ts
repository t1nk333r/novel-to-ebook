import { Hono } from "hono";
import { openApi } from "hono-zod-openapi";
import { ChapterSchema, CreateChapterSchema } from "./schema";
import { contentSelectorList } from "../schema";
import db from "../../../db";
import { uuid, waitFor } from "../../../lib/utils";
import z from "zod";
import {
  insertChapterAtNextIndex,
  queueImportChapters,
  reorderChapters,
  queueImportScrolledChapters,
  queueImportBook,
} from "./repository";
import { streamSSE } from "hono/streaming";
import { importQueue } from "./context";
import { sql } from "kysely";
import { limits } from "../../../lib/limits";

const router = new Hono();

// Create new chapter
router.post(
  "/",
  openApi({
    tags: ["Projects"],
    summary: "Create new chapter",
    request: {
      param: z.object({ projectId: z.string() }),
      json: CreateChapterSchema,
    },
    responses: { 200: ChapterSchema.pick({ id: true, title: true }) },
  }),
  async (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");

    const res = await insertChapterAtNextIndex(projectId, body);

    return c.var.res({ id: res.id, title: res.title });
  },
);

// List chapters
router.get(
  "/",
  openApi({
    tags: ["Projects"],
    summary: "List chapters",
    request: {
      param: z.object({ projectId: z.string() }),
    },
    responses: { 200: z.array(ChapterSchema) },
  }),
  async (c) => {
    const { projectId } = c.req.valid("param");
    const res = await db
      .selectFrom("project_chapters")
      .selectAll()
      .where("projectId", "=", projectId)
      .orderBy("index", "asc")
      .execute();
    return c.var.res(res);
  },
);

router.get("/import", (c) => {
  const projectId = c.req.param("projectId");

  return streamSSE(c, async (stream) => {
    const sendTasks = () => {
      // Namespace-filtered: without the argument every project's stream listed
      // every task in the process-wide queue.
      const tasks = importQueue.getTasks(projectId);
      const data = tasks.map((i) => ({
        id: i.id,
        title: i.title,
        progress: i.progress,
        status: i.status,
        error: i.error,
      }));

      return stream.writeSSE({
        event: "tasks",
        data: JSON.stringify(data),
      });
    };

    const updateFn = importQueue.on("update", async (t) => {
      if (t.namespace === projectId) {
        await sendTasks();
      }
    });
    const errorFn = importQueue.on("error", async (t) => {
      if (t.namespace === projectId) {
        await stream.writeSSE({ event: "error", data: JSON.stringify(t) });
      }
    });

    await sendTasks();
    while (!stream.aborted) {
      await waitFor(1000);
    }

    updateFn();
    errorFn();
  });
});

// Get chapter
router.get(
  "/:id",
  openApi({
    tags: ["Projects"],
    summary: "Get chapter by id",
    request: {
      param: z.object({ projectId: z.string(), id: z.coerce.number() }),
    },
    responses: { 200: ChapterSchema },
  }),
  async (c) => {
    const { projectId, id } = c.req.valid("param");
    const res = await db
      .selectFrom("project_chapters")
      .selectAll()
      .where("projectId", "=", projectId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    return c.var.res(res);
  },
);

// Reorder chapter index
router.put(
  "/reorder",
  openApi({
    tags: ["Projects"],
    summary: "Reorder chapter",
    request: {
      param: z.object({ projectId: z.string() }),
      json: z.object({ ids: z.number().int().positive().array().max(10000) }),
    },
    responses: { 204: { description: "Chapters reordered" } },
  }),
  async (c) => {
    const { projectId } = c.req.valid("param");
    const { ids } = c.req.valid("json");

    await reorderChapters(projectId, ids);

    return c.var.res(204, null);
  },
);

// Update chapter
router.put(
  "/:id",
  openApi({
    tags: ["Projects"],
    summary: "Update chapter",
    request: {
      param: z.object({ projectId: z.string(), id: z.coerce.number() }),
      json: ChapterSchema.pick({ title: true, content: true }).partial(),
    },
    responses: { 200: ChapterSchema },
  }),
  async (c) => {
    const { projectId, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const res = await db
      .updateTable("project_chapters")
      .set(body)
      .where("projectId", "=", projectId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return c.var.res(res);
  },
);

// Delete chapter
router.delete(
  "/:id",
  openApi({
    tags: ["Projects"],
    summary: "Delete chapter",
    request: {
      param: z.object({ projectId: z.string(), id: z.coerce.number() }),
    },
    responses: { 204: { description: "No content" } },
  }),
  async (c) => {
    const { projectId, id } = c.req.valid("param");
    await db
      .deleteFrom("project_chapters")
      .where("projectId", "=", projectId)
      .where("id", "=", id)
      .execute();
    return c.body(null, 204);
  },
);

// Extract & import from links
router.post(
  "/import",
  openApi({
    tags: ["Projects"],
    summary: "Import chapters from links",
    request: {
      param: z.object({ projectId: z.string() }),
      json: z.object({
        links: z
          .object({ url: z.url(), title: z.string().max(1_000) })
          .array()
          .max(limits.importLinks),
        delayMs: z.number().int().min(0).max(limits.actionDelayMs).optional(),
      }),
    },
    responses: { 200: z.object({ taskId: z.uuid() }) },
  }),
  async (c) => {
    const { projectId } = c.req.valid("param");
    const { links, delayMs } = c.req.valid("json");

    const res = queueImportChapters({ projectId, links, delayMs });

    return c.var.res({ taskId: res.id });
  },
);

// Extract & import every chapter a reading page loads as it is scrolled
router.post(
  "/import-scroll",
  openApi({
    tags: ["Projects"],
    summary: "Import chapters a reading page loads while scrolling",
    request: {
      param: z.object({ projectId: z.string() }),
      json: z.object({
        url: z.url(),
        selector: contentSelectorList,
        framePath: z.string().min(1).array().max(limits.frames).nullish(),
        maxScrolls: z.number().int().min(1).max(limits.scrollLoads).optional(),
      }),
    },
    responses: { 200: z.object({ taskId: z.uuid() }) },
  }),
  async (c) => {
    const { projectId } = c.req.valid("param");
    const { url, selector, framePath, maxScrolls } = c.req.valid("json");

    const res = queueImportScrolledChapters({
      projectId,
      url,
      selector,
      framePath,
      maxScrolls,
    });

    return c.var.res({ taskId: res.id });
  },
);

// Import a whole book: catalogue list + reader pages, resumable by chapter id
router.post(
  "/import-book",
  openApi({
    tags: ["Projects"],
    summary: "Import a whole book, resuming where it stopped",
    request: {
      param: z.object({ projectId: z.string() }),
      json: z.object({
        bookUrl: z.url(),
        selector: contentSelectorList,
        framePath: z.string().min(1).array().max(limits.frames).nullish(),
        maxScrolls: z.number().int().min(1).max(limits.scrollLoads).optional(),
        maxChapters: z.number().int().min(1).max(limits.importLinks).optional(),
      }),
    },
    responses: { 200: z.object({ taskId: z.uuid() }) },
  }),
  async (c) => {
    const { projectId } = c.req.valid("param");
    const { bookUrl, selector, framePath, maxScrolls, maxChapters } =
      c.req.valid("json");

    const res = queueImportBook({
      projectId,
      bookUrl,
      selector,
      framePath,
      maxScrolls,
      maxChapters,
    });

    return c.var.res({ taskId: res.id });
  },
);

export default router;