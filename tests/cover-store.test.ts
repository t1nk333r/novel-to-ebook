import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  coverFilePath,
  detectImageType,
  parseCoverRef,
  removeCoverFiles,
  saveCover,
  storedCoverPath,
} from "../src/lib/cover-store";
import { limits } from "../src/lib/limits";

const ID = "01a09bfb-76ea-7145-b1ab-f07f9669e222";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const HTML = new TextEncoder().encode("<!doctype html><title>not an image</title>");

const roots: string[] = [];

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cover-test-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

describe("detectImageType", () => {
  test("identifies the formats an EPUB can carry", () => {
    expect(detectImageType(PNG)).toBe("png");
    expect(detectImageType(JPEG)).toBe("jpg");
    expect(detectImageType(GIF)).toBe("gif");
    expect(detectImageType(WEBP)).toBe("webp");
  });

  test("refuses anything else, including a truncated header", () => {
    expect(detectImageType(HTML)).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
    expect(detectImageType(PNG.slice(0, 4))).toBeNull();
    // GIF87a and GIF89a are images; a bare "GIF8" is not.
    expect(detectImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x30, 0x30]))).toBeNull();
  });
});

describe("cover references", () => {
  test("a stored reference resolves inside the covers directory", () => {
    const ref = `/api/projects/${ID}/cover.png?v=0123456789ab`;
    const stored = storedCoverPath("/data", ref);
    expect(stored).toBe(coverFilePath("/data", ID, "png"));
    expect(stored).toContain(`${path.sep}covers${path.sep}`);
  });

  test("external URLs and traversal attempts are not treated as stored covers", () => {
    expect(storedCoverPath("/data", "https://example.com/a.png")).toBeNull();
    expect(storedCoverPath("/data", null)).toBeNull();
    expect(storedCoverPath("/data", "/api/projects/../../etc/cover.png")).toBeNull();
    expect(storedCoverPath("/data", `/api/projects/${ID}/cover.${"../".repeat(4)}x`)).toBeNull();
    expect(parseCoverRef(`/api/projects/${ID}/cover.png`)).toEqual({ projectId: ID, ext: "png" });
  });

  test("a malformed project id or extension cannot reach the filesystem", () => {
    expect(() => coverFilePath("/data", "../../etc/passwd", "png")).toThrow();
    expect(() => coverFilePath("/data", ID, "../../etc/passwd")).toThrow();
    expect(() => coverFilePath("/data", ID, "svg")).toThrow();
  });
});

describe("saveCover", () => {
  test("stores the bytes and reports a versioned reference", async () => {
    const root = await tempRoot();
    const saved = await saveCover(root, ID, PNG);

    expect(saved.ext).toBe("png");
    expect(saved.mime).toBe("image/png");
    expect(saved.ref).toBe(`/api/projects/${ID}/cover.png?v=${saved.version}`);
    expect(saved.version).toMatch(/^[0-9a-f]{12}$/);
    expect(new Uint8Array(await fs.readFile(coverFilePath(root, ID, "png")))).toEqual(PNG);
  });

  test("replacing a cover in another format leaves no stale sibling", async () => {
    const root = await tempRoot();
    await saveCover(root, ID, PNG);
    await saveCover(root, ID, JPEG);

    const entries = await fs.readdir(path.join(root, "covers"));
    expect(entries).toEqual([`${ID}.jpg`]);
  });

  test("refuses an oversized or non-image body before writing anything", async () => {
    const root = await tempRoot();

    await expect(saveCover(root, ID, HTML)).rejects.toThrow(/PNG, JPEG, WebP or GIF/);
    await expect(saveCover(root, ID, new Uint8Array(limits.coverBytes + 1))).rejects.toThrow(
      /over the .* byte limit/,
    );
    await expect(fs.access(path.join(root, "covers"))).rejects.toThrow();
  });
});

describe("removeCoverFiles", () => {
  test("removes every format for a project and ignores a missing directory", async () => {
    const root = await tempRoot();
    await saveCover(root, ID, PNG);
    await removeCoverFiles(root, ID);
    expect(await fs.readdir(path.join(root, "covers"))).toEqual([]);

    await removeCoverFiles(root, "not-a-uuid");
    await removeCoverFiles(path.join(root, "absent"), ID);
  });
});
