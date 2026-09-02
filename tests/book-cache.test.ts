import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  buildValidators,
  contentTypeForName,
  isNotModified,
} from "../src/app/library/file-validators";

describe("file-validators (pure)", () => {
  test("derives an etag/last-modified from stat size+mtime, not content", () => {
    const a = buildValidators({ size: 100, mtimeMs: 1_700_000_000_000 });
    const b = buildValidators({ size: 100, mtimeMs: 1_700_000_000_000 });
    const changedSize = buildValidators({
      size: 101,
      mtimeMs: 1_700_000_000_000,
    });
    const changedMtime = buildValidators({
      size: 100,
      mtimeMs: 1_700_000_001_000,
    });

    expect(a.etag).toBe(b.etag);
    expect(a.etag).not.toBe(changedSize.etag);
    expect(a.etag).not.toBe(changedMtime.etag);
    expect(a.lastModified).toBe(
      new Date(1_700_000_000_000).toUTCString(),
    );
  });

  test("matches on If-None-Match", () => {
    const validators = buildValidators({ size: 42, mtimeMs: 1000 });
    expect(isNotModified({ ifNoneMatch: validators.etag }, validators)).toBe(
      true,
    );
    expect(
      isNotModified({ ifNoneMatch: `W/"stale"` }, validators),
    ).toBe(false);
    expect(isNotModified({ ifNoneMatch: "*" }, validators)).toBe(true);
  });

  test("If-None-Match takes precedence over If-Modified-Since", () => {
    const validators = buildValidators({ size: 42, mtimeMs: 1000 });
    expect(
      isNotModified(
        {
          ifNoneMatch: `W/"stale"`,
          ifModifiedSince: validators.lastModified,
        },
        validators,
      ),
    ).toBe(false);
  });

  test("falls back to If-Modified-Since", () => {
    const validators = buildValidators({ size: 42, mtimeMs: 1000 });
    const future = new Date(Date.parse(validators.lastModified) + 60_000);
    const past = new Date(Date.parse(validators.lastModified) - 60_000);

    expect(
      isNotModified({ ifModifiedSince: future.toUTCString() }, validators),
    ).toBe(true);
    expect(
      isNotModified({ ifModifiedSince: past.toUTCString() }, validators),
    ).toBe(false);
    expect(isNotModified({}, validators)).toBe(false);
  });

  test("maps known extensions to content types and falls back otherwise", () => {
    expect(contentTypeForName("Novel.epub")).toBe("application/epub+zip");
    expect(contentTypeForName("Novel.PDF")).toBe("application/pdf");
    expect(contentTypeForName("Novel.txt")).toBe("application/octet-stream");
  });
});

describe("GET /library/get (conditional requests)", () => {
  let tmpDir: string;
  let epubPath: string;
  let pdfPath: string;
  let app: import("hono").Hono<any, any, any>;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "storvi-book-cache-"));
    epubPath = path.join(tmpDir, "book.epub");
    pdfPath = path.join(tmpDir, "book.pdf");
    await fs.writeFile(epubPath, "epub-body-v1");
    await fs.writeFile(pdfPath, "pdf-body-v1");

    // DB is only touched by unrelated routes on this router, but importing
    // the module still requires DATABASE_URL to be set. Point it at a
    // temporary, throwaway path -- never the user's real data.
    process.env.DATABASE_URL = path.join(tmpDir, "throwaway.sqlite");

    const items = [
      {
        key: "book.epub",
        name: "book.epub",
        path: tmpDir,
        parent: "",
        fullPath: epubPath,
        isDirectory: false,
        metadata: {},
        cover: null,
        coverHash: null,
        getCover: undefined,
      },
      {
        key: "book.pdf",
        name: "book.pdf",
        path: tmpDir,
        parent: "",
        fullPath: pdfPath,
        isDirectory: false,
        metadata: {},
        cover: null,
        coverHash: null,
        getCover: undefined,
      },
    ];

    // Replace context.ts's library accessor with a fixed in-memory fixture
    // so the route is exercised without a real (slow, network-touching)
    // library scan.
    await mock.module(
      path.resolve(import.meta.dir, "../src/app/library/context.ts"),
      () => ({
        getLibrary: () => items,
        rescanLibrary: async () => {},
      }),
    );

    const mod = await import("../src/app/library/routes");
    app = mod.default;
  });

  afterAll(async () => {
    mock.restore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("unchanged cached open transfers no book body (304)", async () => {
    const first = await app.request("/get?key=book.epub");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    const lastModified = first.headers.get("last-modified");
    expect(etag).toBeTruthy();
    expect(lastModified).toBeTruthy();

    const second = await app.request("/get?key=book.epub", {
      headers: { "if-none-match": etag! },
    });
    expect(second.status).toBe(304);
    const body = await second.arrayBuffer();
    expect(body.byteLength).toBe(0);
  });

  test("changed file returns 200 with fresh body once validators go stale", async () => {
    const first = await app.request("/get?key=book.epub");
    const staleEtag = first.headers.get("etag")!;

    // Ensure the mtime actually advances on filesystems with coarse
    // resolution, then rewrite with different content/size.
    await new Promise((r) => setTimeout(r, 10));
    await fs.writeFile(epubPath, "epub-body-v2-longer");

    const res = await app.request("/get?key=book.epub", {
      headers: { "if-none-match": staleEtag },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("epub-body-v2-longer");
    expect(res.headers.get("etag")).not.toBe(staleEtag);
  });

  test("epub and pdf get their own content types", async () => {
    const epubRes = await app.request("/get?key=book.epub");
    expect(epubRes.headers.get("content-type")).toBe("application/epub+zip");

    const pdfRes = await app.request("/get?key=book.pdf");
    expect(pdfRes.headers.get("content-type")).toBe("application/pdf");
  });

  test("unknown key still reports 404", async () => {
    const res = await app.request("/get?key=missing.epub");
    expect(res.status).toBe(404);
  });
});
