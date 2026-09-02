import type { BookRelocate } from "@/app/reader/lib/types";
import { openDB, type DBSchema } from "idb";

export interface CachedBook {
  file: File;
  // HTTP validators from the server response, used to make a small
  // conditional request instead of re-downloading the whole file.
  // `null` means "unknown" (e.g. migrated from the pre-validator schema),
  // which forces one full refresh to backfill them.
  etag: string | null;
  lastModified: string | null;
}

export interface Database extends DBSchema {
  queries: { key: string; value: string };
  images: { key: string; value: Blob };
  books: { key: string; value: CachedBook };
  histories: {
    key: string;
    value: {
      key: string;
      name: string;
      metadata?: any;
      cover?: string | null;
      location: BookRelocate;
      date: Date;
    };
    indexes: {
      date: Date;
    };
  };
}

export type DBValue<T extends keyof Database> = Database[T]["value"];

const DB_VERSION = 2;

export async function getDB() {
  return openDB<Database>("storvi", DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore("queries");
        db.createObjectStore("images");
        db.createObjectStore("books");

        const histories = db.createObjectStore("histories");
        histories.createIndex("date", "date");
      }

      if (oldVersion < 2) {
        // Pre-v2, "books" stored a raw File. Wrap existing entries in the
        // new { file, etag, lastModified } shape so lookups keep working;
        // unknown validators just mean the next open does one full refresh.
        const store = tx.objectStore("books");
        let cursor = await store.openCursor();
        while (cursor) {
          const value = cursor.value as unknown;
          if (value instanceof File) {
            await cursor.update({
              file: value,
              etag: null,
              lastModified: null,
            } satisfies CachedBook);
          }
          cursor = await cursor.continue();
        }
      }
    },
  });
}
