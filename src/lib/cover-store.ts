import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HTTPError } from "./error";
import { limits } from "./limits";

/**
 * Covers the operator picks from their own device are stored here instead of
 * being fetched from a URL. Two reasons that is the honest design for this
 * deployment: a cover may live on a host the SSRF policy refuses to touch (see
 * `network-policy.ts` — a private address is a private address), and the server
 * often cannot reach the operator's LAN at all. A file that arrives in the
 * request body needs no policy, no DNS, and no reachability.
 *
 * The stored form is `<dataRoot>/covers/<projectId>.<ext>`, referenced from
 * `projects.cover` as `/api/projects/<projectId>/cover.<ext>?v=<hash>`. The
 * version hash matters: the reader caches images by URL, so a replaced cover
 * must arrive under a new one.
 */

export type CoverExt = "jpg" | "png" | "webp" | "gif";

export const COVER_EXTENSIONS: readonly CoverExt[] = ["jpg", "png", "webp", "gif"];

const COVER_MIME: Record<CoverExt, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const COVER_DIRECTORY = "covers";

/** Project ids are UUIDs; anything else never reaches the filesystem. */
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/api/projects/<uuid>/cover`, with an optional `?v=` cache version. The route
 * is a single literal segment — the format lives in the file, not the URL — but
 * an extension is tolerated so a reference written before that rule still
 * resolves.
 */
const COVER_REF =
  /^\/api\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/cover(?:\.[a-z]{3,4})?(?:\?v=[0-9a-f]{1,32})?$/i;

export function isCoverExt(value: string): value is CoverExt {
  return (COVER_EXTENSIONS as readonly string[]).includes(value);
}

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0) {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Identify the image by its bytes, never by the filename or the upload's
 * content type: those are the client's claims, and a mislabelled file would be
 * written into an EPUB that then fails to open.
 */
export function detectImageType(bytes: Uint8Array): CoverExt | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return bytes[4] === 0x37 || bytes[4] === 0x39 ? "gif" : null; // GIF87a / GIF89a
  }
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "webp";
  }
  return null;
}

export function coverDirectory(dataRoot: string) {
  return path.join(dataRoot, COVER_DIRECTORY);
}

function invalidCoverPath() {
  return new HTTPError("Invalid cover path", {
    status: 400,
    code: "INVALID_COVER_PATH",
  });
}

/** `<projectId>.<ext>` — both halves validated, so the join cannot escape. */
export function coverFileName(projectId: string, ext: string) {
  if (!PROJECT_ID.test(projectId) || !isCoverExt(ext)) throw invalidCoverPath();
  return `${projectId.toLowerCase()}.${ext}`;
}

export function coverFilePath(dataRoot: string, projectId: string, ext: string) {
  return path.join(coverDirectory(dataRoot), coverFileName(projectId, ext));
}

/** The project a cover reference belongs to, or null for an external URL. */
export function parseCoverRef(cover: string | null | undefined) {
  if (!cover) return null;
  const match = COVER_REF.exec(cover.trim());
  if (!match) return null;
  return { projectId: match[1]!.toLowerCase() };
}

export function coverRef(projectId: string, version: string) {
  return `/api/projects/${projectId.toLowerCase()}/cover?v=${version}`;
}

/**
 * The file this app stored for a project, or null when the reference is an
 * external URL or the file is gone. The format is read off the directory rather
 * than rebuilt from the reference, so a replaced cover in another format still
 * resolves.
 */
export async function storedCoverFile(dataRoot: string, cover: string | null | undefined) {
  const parsed = parseCoverRef(cover);
  if (!parsed) return null;

  const directory = coverDirectory(dataRoot);
  const prefix = `${parsed.projectId}.`;
  try {
    const entry = (await fs.readdir(directory)).find((name) => name.startsWith(prefix));
    return entry ? path.join(directory, entry) : null;
  } catch {
    return null;
  }
}

export async function saveCover(dataRoot: string, projectId: string, bytes: Uint8Array) {
  if (bytes.byteLength === 0) {
    throw new HTTPError("Cover image is empty", { status: 400, code: "UNSUPPORTED_COVER_IMAGE" });
  }

  if (bytes.byteLength > limits.coverBytes) {
    throw new HTTPError(
      `Cover image is ${bytes.byteLength} bytes, over the ${limits.coverBytes} byte limit`,
      { status: 413, code: "COVER_TOO_LARGE" },
    );
  }

  const ext = detectImageType(bytes);
  if (!ext) {
    throw new HTTPError("Cover must be a PNG, JPEG, WebP or GIF image", {
      status: 400,
      code: "UNSUPPORTED_COVER_IMAGE",
    });
  }

  const directory = coverDirectory(dataRoot);
  await fs.mkdir(directory, { recursive: true });

  // Drop siblings from an earlier format so `<id>.png` and `<id>.jpg` cannot
  // both survive and be served under one of two references.
  const target = coverFileName(projectId, ext);
  for (const entry of await fs.readdir(directory)) {
    if (entry.startsWith(`${projectId.toLowerCase()}.`) && entry !== target) {
      await fs.rm(path.join(directory, entry), { force: true });
    }
  }

  await fs.writeFile(path.join(directory, target), bytes);

  const version = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return { ext, mime: COVER_MIME[ext], version, ref: coverRef(projectId, version) };
}

export async function readCoverFile(filePath: string) {
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return { data, mime: isCoverExt(ext) ? COVER_MIME[ext] : "application/octet-stream" };
  } catch {
    return null;
  }
}

/** Best-effort: a cover that cannot be removed must not fail the delete. */
export async function removeCoverFiles(dataRoot: string, projectId: string) {
  if (!PROJECT_ID.test(projectId)) return;

  const directory = coverDirectory(dataRoot);
  try {
    for (const entry of await fs.readdir(directory)) {
      if (entry.startsWith(`${projectId.toLowerCase()}.`)) {
        await fs.rm(path.join(directory, entry), { force: true });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`cover: could not remove files for ${projectId} — ${String(error)}`);
    }
  }
}
