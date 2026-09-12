import { Hono } from "hono";
import { openApi } from "hono-zod-openapi";
import {
  ListLibraryResponseSchema,
  GetLibraryRequestSchema,
  GetLibraryResponseSchema,
  GetCoverRequestSchema,
  GetCoverResponseSchema,
  LibraryItemSchema,
} from "./schema";
import { HTTPError } from "../../lib/error";
import { getLibrary, rescanLibrary } from "./context";
import z from "zod";
import db from "../../db";
import fs from "fs/promises";
import {
  buildValidators,
  contentTypeForName,
  isNotModified,
} from "./file-validators";

const router = new Hono();

router.get(
  "/",
  openApi({
    tags: ["Library"],
    summary: "List library",
    responses: { 200: ListLibraryResponseSchema },
  }),
  async (c) => {
    return c.var.res(getLibrary());
  },
);

router.post(
  "/rescan",
  openApi({
    tags: ["Library"],
    summary: "Rescan library",
    responses: { 204: { description: "No content" } },
  }),
  async (c) => {
    const result = await rescanLibrary();
    if (!result.ok) {
      throw new HTTPError("Library scan failed", {
        status: 500,
        code: "LIBRARY_SCAN_FAILED",
      });
    }

    return c.var.res(204, null);
  },
);

router.get(
  "/detail",
  openApi({
    tags: ["Library"],
    summary: "Get item detail",
    request: { query: GetLibraryRequestSchema },
    responses: {
      200: LibraryItemSchema,
    },
  }),
  async (c) => {
    const { key } = c.req.valid("query");
    const item = getLibrary().find((i) => i.key === key && !i.isDirectory);
    if (!item) {
      throw new HTTPError("Library item not found", { status: 404 });
    }

    return c.var.res(item);
  },
);

router.get(
  "/get",
  openApi({
    tags: ["Library"],
    summary: "Get library file",
    request: { query: GetLibraryRequestSchema },
    responses: {
      200: {
        schema: GetLibraryResponseSchema,
        mediaType: "application/epub+zip",
      },
      304: { description: "Not modified" },
    },
  }),
  async (c) => {
    const { key } = c.req.valid("query");
    const item = getLibrary().find((i) => i.key === key && !i.isDirectory);
    if (!item) {
      throw new HTTPError("Library item not found", { status: 404 });
    }

    // Identity comes from stat size/mtime only -- never read the file just
    // to compare it, that would defeat the point of a conditional request.
    const stat = await fs.stat(item.fullPath);
    const validators = buildValidators(stat);

    if (
      isNotModified(
        {
          ifNoneMatch: c.req.header("if-none-match"),
          ifModifiedSince: c.req.header("if-modified-since"),
        },
        validators,
      )
    ) {
      return c.body(null, 304, {
        ETag: validators.etag,
        "Last-Modified": validators.lastModified,
      });
    }

    const file = Bun.file(item.fullPath);
    return new Response(file, {
      headers: {
        "Content-Type": contentTypeForName(item.name),
        "Content-Disposition": `attachment; filename="${item.name}"`,
        ETag: validators.etag,
        "Last-Modified": validators.lastModified,
      },
    });
  },
);

router.get(
  "/cover.jpeg",
  openApi({
    tags: ["Library"],
    summary: "Get library cover",
    request: { query: GetCoverRequestSchema },
    responses: {
      200: { schema: GetCoverResponseSchema, mediaType: "image/jpeg" },
    },
  }),
  async (c) => {
    const { key } = c.req.valid("query");
    const item = getLibrary().find((i) => i.key === key && !i.isDirectory);
    if (!item) {
      throw new HTTPError("Library item not found", { status: 404 });
    }

    const cover = item.getCover ? await item.getCover() : null;
    if (!cover?.data || !cover.data?.length) {
      throw new HTTPError("Cover not found", { status: 404 });
    }

    return c.body(Buffer.from(cover.data), 200, {
      "Content-Type": cover.mimeType,
    });
  },
);

router.get(
  "/history",
  openApi({
    responses: {
      200: z
        .object({
          key: z.string(),
          name: z.string(),
          date: z.iso.date(),
          location: z.any(),
          metadata: z.any().nullish(),
          cover: z.string().nullish(),
        })
        .array(),
    },
  }),
  async (c) => {
    const libraries = getLibrary();
    const res = await db
      .selectFrom("histories")
      .selectAll()
      .limit(10)
      .orderBy("date", "desc")
      .execute();

    const items = res
      .map((i) => {
        const libItem = libraries.find(
          (l) => l.key === i.key && !l.isDirectory,
        );
        return {
          key: i.key,
          name: i.key.split("/").pop()?.split(".").slice(0, -1).join(".") || "",
          date: i.date,
          metadata: libItem?.metadata,
          cover: libItem?.cover,
          location: JSON.parse(i.location),
        };
      })
      .filter((i) => !!i.metadata);

    return c.var.res(items);
  },
);

router.get(
  "/progress",
  openApi({
    request: {
      query: z.object({ key: z.string().min(1) }),
    },
    responses: {
      200: z.object({
        location: z.any(),
        date: z.iso.date(),
      }),
    },
  }),
  async (c) => {
    const { key } = c.req.valid("query");
    const item = getLibrary().find((i) => i.key === key && !i.isDirectory);
    if (!item) {
      throw new HTTPError("Library item not found", { status: 404 });
    }

    const progress = await db
      .selectFrom("histories")
      .selectAll()
      .where("key", "=", key)
      .limit(1)
      .orderBy("date", "desc")
      .executeTakeFirstOrThrow();

    return c.var.res({
      date: progress.date,
      location: JSON.parse(progress.location),
    });
  },
);

router.put(
  "/progress",
  openApi({
    request: {
      json: z.object({
        key: z.string().min(1),
        location: z.any(),
        date: z.iso.datetime(),
      }),
    },
    responses: {
      204: { description: "No content" },
    },
  }),
  async (c) => {
    const { key, location, date } = c.req.valid("json");
    const item = getLibrary().find((i) => i.key === key && !i.isDirectory);
    if (!item) {
      throw new HTTPError("Library item not found", { status: 404 });
    }

    await db
      .insertInto("histories")
      .values({
        key,
        location: JSON.stringify(location),
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          location: JSON.stringify(location),
          date,
        }),
      )
      .execute();

    return c.body(null, 204);
  },
);

export default router;
