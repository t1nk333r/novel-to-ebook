import { $api, API_URL } from "@/lib/api";
import { apiAuthHeader } from "@/lib/api-auth";
import type { paths } from "@/lib/api.schema";
import { getDB, type CachedBook } from "@/lib/db";
import { getApiToken, reportUnauthorized } from "@/stores/auth.store";
import { useEffect, useState } from "react";

function createApiCacheKey(method: string, path: string, options?: any) {
  return JSON.stringify({
    method,
    path,
    params: options?.params ?? null,
    query: options?.query ?? null,
  });
}

export function useOfflineApiQuery(
  method: "get" | "post" | "put" | "delete" | "patch",
  path: keyof paths,
  options?: any,
) {
  const cacheKey = createApiCacheKey(method, path, options);
  const query = $api.useQuery(method, path as never, options);
  const [cachedData, setCachedData] = useState<any>();

  // load cached data first
  useEffect(() => {
    getDB()
      .then((db) => db.get("queries", cacheKey))
      .then((data) => {
        if (data) setCachedData(data);
      });
  }, [cacheKey]);

  // persist fresh data
  useEffect(() => {
    if (query.data) {
      getDB().then((db) => db.put("queries", query.data, cacheKey));
    }
  }, [query.data, cacheKey]);

  return {
    ...query,
    // fallback to cache
    data: query.data ?? cachedData,
    isOfflineFallback: !query.data && !!cachedData,
  };
}

const imagesCache = new Map<string, string>();

export async function getOfflineImage(
  url: string,
  onDbCache?: (url: string) => void,
) {
  if (imagesCache.has(url)) {
    return imagesCache.get(url)!;
  }

  const cachedBlob = await getDB().then((db) => db.get("images", url));
  let cached: string | null = null;

  if (cachedBlob) {
    cached = URL.createObjectURL(cachedBlob);
    imagesCache.set(url, cached);
    onDbCache?.(cached);
  }

  try {
    const header = apiAuthHeader(url, window.location.origin, getApiToken());
    const res = await fetch(url, header ? { headers: header } : undefined);
    if (res.status === 401) reportUnauthorized();
    if (!res.ok) throw new Error("network");

    const blob = await res.blob();
    await getDB().then((db) => db.put("images", blob, url));

    const obj = URL.createObjectURL(blob);
    imagesCache.set(url, obj);

    return obj;
  } catch (e) {
    if (!cached) throw new Error("no cached image");
    return cached;
  }
}

type FetchBookResult =
  | { status: "fresh"; record: CachedBook }
  | { status: "not-modified" };

/**
 * Fetch a book from the server. When `conditional` validators are given and
 * the server confirms nothing changed, this resolves without ever reading a
 * response body (a 304 short-circuit) instead of always downloading the
 * whole file.
 */
async function fetchBook(
  key: string,
  conditional?: { etag: string | null; lastModified: string | null },
): Promise<FetchBookResult> {
  const target = API_URL + "/library/get?key=" + encodeURIComponent(key);
  const headers: Record<string, string> = {
    ...apiAuthHeader(target, window.location.origin, getApiToken()),
  };
  if (conditional?.etag) headers["If-None-Match"] = conditional.etag;
  if (conditional?.lastModified) {
    headers["If-Modified-Since"] = conditional.lastModified;
  }

  const res = await fetch(
    target,
    Object.keys(headers).length ? { headers } : undefined,
  );

  if (res.status === 401) {
    reportUnauthorized();
    throw new Error("Unauthorized");
  }

  if (res.status === 304) {
    return { status: "not-modified" };
  }

  if (!res.ok) throw new Error(res.statusText);

  const buf = await res.arrayBuffer();
  const disposition = res.headers.get("content-disposition");
  const filename = disposition
    ? disposition.split("filename=")[1]?.replace(/"/g, "")
    : "book.epub";
  const contentType = res.headers.get("content-type") || "application/epub+zip";
  const file = new File([buf], filename, { type: contentType });

  const record: CachedBook = {
    file,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
  };

  // store for offline usage
  await getDB().then((db) => db.put("books", record, key));

  return { status: "fresh", record };
}

export async function getBookData(
  key: string,
  onFileChanged?: (file: File) => void,
) {
  const cached = await getDB().then((db) => db.get("books", key));

  if (cached) {
    // Return the cache immediately, then refresh in the background with a
    // conditional request. This never blocks the caller and must never
    // throw an unhandled rejection -- that's exactly the offline path the
    // cache exists to serve.
    fetchBook(key, { etag: cached.etag, lastModified: cached.lastModified })
      .then((result) => {
        if (result.status === "fresh") {
          onFileChanged?.(result.record.file);
        }
      })
      .catch((err) => {
        console.warn("Background book refresh failed (offline?)", err);
      });

    return cached.file;
  }

  const result = await fetchBook(key);
  if (result.status === "not-modified") {
    // Can't happen without conditional headers, but keep TS/callers honest.
    throw new Error("Unexpected 304 response for an uncached book");
  }
  return result.record.file;
}
