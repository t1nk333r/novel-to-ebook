import { inflateRawSync } from "node:zlib";

/**
 * A minimal zip reader.
 *
 * Needed because the app can *write* EPUBs (the export path) but had no way to
 * read one back, and Bun's built-in `Bun.Archive` handles tar, not zip. Reading
 * an EPUB means reading a zip, so this does that and nothing else: no writer, no
 * streaming, no encryption, and hard bounds so a hostile archive cannot exhaust
 * memory.
 */

/** Guards for an archive from anywhere: an EPUB is a document, not a disk image. */
export const ZIP_LIMITS = {
  maxEntries: 5000,
  /** Per entry, uncompressed. */
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
};

type Entry = { name: string; offset: number; compressedSize: number; size: number; method: number };

function findEndOfCentralDirectory(view: DataView) {
  // The EOCD is the last 22 bytes plus an optional comment of up to 64 KiB.
  const earliest = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let index = view.byteLength - 22; index >= earliest; index--) {
    if (view.getUint32(index, true) === 0x06054b50) return index;
  }
  return -1;
}

function readEntries(view: DataView): Entry[] {
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory)");

  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count > ZIP_LIMITS.maxEntries) {
    throw new Error(`zip has ${count} entries, over the ${ZIP_LIMITS.maxEntries} limit`);
  }

  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  let cursor = directoryOffset;

  for (let index = 0; index < count; index++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("corrupt central directory");

    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const name = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + cursor + 46, nameLength));

    entries.push({
      name,
      method: view.getUint16(cursor + 10, true),
      compressedSize: view.getUint32(cursor + 20, true),
      size: view.getUint32(cursor + 24, true),
      offset: view.getUint32(cursor + 42, true),
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readEntry(view: DataView, bytes: Uint8Array, entry: Entry) {
  if (entry.size > ZIP_LIMITS.maxEntryBytes) {
    throw new Error(`zip entry ${entry.name} is larger than the limit`);
  }
  if (view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error("corrupt local header");

  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const raw = bytes.subarray(start, start + entry.compressedSize);

  // 0 = stored, 8 = deflate. Anything else (bzip2, LZMA, encryption) is refused
  // rather than guessed at.
  if (entry.method === 0) return raw;
  if (entry.method === 8) return new Uint8Array(inflateRawSync(raw));
  throw new Error(`zip entry ${entry.name} uses unsupported compression ${entry.method}`);
}

export type ZipArchive = {
  names: string[];
  entry(name: string): Uint8Array | null;
  text(name: string): string | null;
};

/** Read every entry up front: an EPUB is small, and this keeps the API simple. */
export function openZip(input: Uint8Array): ZipArchive {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readEntries(view);

  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > ZIP_LIMITS.maxTotalBytes) throw new Error("zip is larger than the limit");

  const contents = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue; // directory marker
    contents.set(entry.name, readEntry(view, bytes, entry));
  }

  const decoder = new TextDecoder();
  return {
    names: [...contents.keys()],
    entry: (name) => contents.get(name) ?? null,
    text: (name) => {
      const value = contents.get(name);
      return value ? decoder.decode(value) : null;
    },
  };
}
