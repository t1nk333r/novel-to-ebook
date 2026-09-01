/**
 * HTTP validator (ETag / Last-Modified) helpers for serving library files.
 *
 * Identity is derived exclusively from cheap `stat` metadata (size + mtime),
 * never from file contents -- reading the whole file just to compare it
 * would defeat the point of a conditional request.
 */

export interface FileStatLike {
  size: number;
  mtimeMs: number;
}

export interface FileValidators {
  etag: string;
  lastModified: string;
}

export function buildValidators(stat: FileStatLike): FileValidators {
  const mtimeMs = Math.trunc(stat.mtimeMs);
  return {
    etag: `W/"${stat.size.toString(16)}-${mtimeMs.toString(16)}"`,
    lastModified: new Date(mtimeMs).toUTCString(),
  };
}

export interface ConditionalHeaders {
  ifNoneMatch?: string | null;
  ifModifiedSince?: string | null;
}

/** True when the client's cached copy is still fresh and a 304 should be sent. */
export function isNotModified(
  headers: ConditionalHeaders,
  validators: FileValidators,
): boolean {
  // If-None-Match takes precedence over If-Modified-Since per RFC 9110 §13.1.2.
  if (headers.ifNoneMatch) {
    const tags = headers.ifNoneMatch.split(",").map((t) => t.trim());
    return tags.includes("*") || tags.includes(validators.etag);
  }

  if (headers.ifModifiedSince) {
    const since = Date.parse(headers.ifModifiedSince);
    const lastModified = Date.parse(validators.lastModified);
    if (!Number.isNaN(since) && !Number.isNaN(lastModified)) {
      return lastModified <= since;
    }
  }

  return false;
}

const CONTENT_TYPES: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
};

export function contentTypeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
