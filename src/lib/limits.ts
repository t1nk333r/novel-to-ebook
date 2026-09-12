function readPositiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export const limits = {
  requestBodyBytes: readPositiveInteger("MAX_REQUEST_BODY_BYTES", 1_000_000),
  textLength: readPositiveInteger("MAX_TEXT_LENGTH", 500_000),
  selectorLength: readPositiveInteger("MAX_SELECTOR_LENGTH", 2_000),
  importLinks: readPositiveInteger("MAX_IMPORT_LINKS", 500),
  browserActions: readPositiveInteger("MAX_BROWSER_ACTIONS", 50),
  blockSelectors: readPositiveInteger("MAX_BLOCK_SELECTORS", 100),
  contentSelectors: readPositiveInteger("MAX_CONTENT_SELECTORS", 20),
  actionAttempts: readPositiveInteger("MAX_ACTION_ATTEMPTS", 20),
  actionDelayMs: readPositiveInteger("MAX_ACTION_DELAY_MS", 60_000),
  viewportDimension: readPositiveInteger("MAX_VIEWPORT_DIMENSION", 4_096),
  screenshotPixels: readPositiveInteger("MAX_SCREENSHOT_PIXELS", 16_000_000),
  fetchedBytes: readPositiveInteger("MAX_FETCHED_BYTES", 10_000_000),
  fetchTimeoutMs: readPositiveInteger("FETCH_TIMEOUT_MS", 30_000),
  redirects: readPositiveInteger("MAX_FETCH_REDIRECTS", 5),
  browserConcurrency: readPositiveInteger("MAX_BROWSER_CONCURRENCY", 3),
  aiConcurrency: readPositiveInteger("MAX_AI_CONCURRENCY", 2),
  scanConcurrency: readPositiveInteger("MAX_SCAN_CONCURRENCY", 4),
} as const;
