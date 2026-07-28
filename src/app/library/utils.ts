import fs from "fs/promises";
import path from "path";
import EPub from "epub";
import * as blurhash from "blurhash";
import sharp from "sharp";
import { pdfToImg } from "pdftoimg-js";
import db from "../../db";

const supportExt = ["epub", "pdf"];

export async function scanLibrary(
  paths: string[],
  opt?: { signal?: AbortSignal },
) {
  const { signal } = opt || {};
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

  const files = await Promise.all(
    paths.map(async (p) => {
      signal?.throwIfAborted();
      const basePath = path.resolve(p);

      let entries = await fs.readdir(p, {
        recursive: true,
        withFileTypes: true,
      });

      entries = entries.filter((entry) => {
        signal?.throwIfAborted();

        if (entry.isDirectory()) return true;
        if (entry.isFile()) {
          const ext = entry.name.split(".").pop();
          return supportExt.includes(ext?.toLowerCase() ?? "");
        }
        return false;
      });

      const result = await Promise.all(
        entries.map(async (entry: any) => {
          signal?.throwIfAborted();

          const fullPath = path.join(entry.path ?? p, entry.name);
          const relative = path.relative(p, fullPath);
          const parent = path
            .dirname(relative)
            .replaceAll("\\", "/")
            .replaceAll(".", "")
            .replaceAll("..", "");
          const key = relative.replaceAll("\\", "/");
          const stat = await fs.stat(fullPath);

          let metadata: Record<string, string> = {
            title: entry.name.split(".").slice(0, -1).join("."),
          };
          let getCover:
            | (() => Promise<{
                data: Buffer<ArrayBufferLike>;
                mimeType: string;
              }>)
            | undefined = undefined;
          let cover: string | null = null;
          let coverHash: string | null = null;

          try {
            if (entry.name.endsWith(".epub")) {
              const epub = new EPub(fullPath);
              await epub.parse();
              metadata = epub.metadata as never;

              const coverId = (epub.metadata as any).cover;
              if (coverId) {
                try {
                  const image = await epub.getImage(coverId);
                  const coverData = await compressImage(image.data, 256);

                  getCover = async () => ({
                    data: coverData,
                    mimeType: "image/webp",
                  });
                  cover = getCoverUrl(key);
                  coverHash = await createBlurHash(image.data);
                } catch (err) {
                  console.error(err);
                }
              }
            }

            if (entry.name.endsWith(".pdf")) {
              const coverImg = await pdfToImg(fullPath, {
                pages: "firstPage",
                imgType: "jpg",
              });
              const coverBuf = Buffer.from(
                coverImg.replace("data:image/jpeg;base64,", ""),
                "base64",
              );

              try {
                const coverData = await compressImage(coverBuf, 256);
                getCover = async () => ({
                  data: coverData,
                  mimeType: "image/webp",
                });
                cover = getCoverUrl(key);
                coverHash = await createBlurHash(coverData);
              } catch (err) {
                console.error(err);
              }
            }
          } catch (err) {
            console.log("Err reading file!", entry.name, err);
          }

          return {
            key,
            name: entry.name,
            path: basePath,
            parent,
            fullPath,
            isDirectory: entry.isDirectory(),
            metadata: {
              ...metadata,
              created: stat.birthtimeMs,
              modified: stat.mtimeMs,
              readAt: readHistories[key] || null,
            },
            cover,
            coverHash,
            getCover,
          };
        }),
      );

      signal?.throwIfAborted();

      // fill directory metadata
      result.forEach((item, idx) => {
        if (!item.isDirectory || signal?.aborted) return;

        // cover
        result[idx]!.cover =
          result.find((i) => i.parent === item.key && i.cover != null)?.cover ||
          null;

        // read metadata
        result[idx]!.metadata.readAt =
          result
            .filter((i) => i.parent === item.key && i.metadata.readAt)
            .sort((a, b) => b.metadata.readAt! - a.metadata.readAt!)[0]
            ?.metadata.readAt || null;
      });

      return result;
    }),
  );

  return files.flat();
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
