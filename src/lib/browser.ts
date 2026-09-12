import {
  Browser,
  DEFAULT_INTERCEPT_RESOLUTION_PRIORITY,
  ElementHandle,
  Page,
} from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import BlockResourcesPlugin from "puppeteer-extra-plugin-block-resources";
import { PuppeteerBlocker } from "@ghostery/adblocker-puppeteer";
import { waitFor } from "./utils";
import { isAllowedOutboundUrl } from "./network-policy";
import { type Action, type ActionWithLoopUntil } from "../app/projects/schema";

let browserPromise: Promise<Browser> | null = null;
let blocker: PuppeteerBlocker | null = null;

const blockResources = BlockResourcesPlugin({
  blockedTypes: new Set([
    "image",
    "stylesheet",
    "media",
    "font",
    "manifest",
    "other",
  ]),
  interceptResolutionPriority: DEFAULT_INTERCEPT_RESOLUTION_PRIORITY,
});

export async function getBrowser(opt?: { headless?: boolean }) {
  // Single-flight: the executor admits several callers at cold start, and a
  // bare `if (!browser)` check left the second caller launching its own
  // Chromium whose handle was then overwritten — leaking a process for the
  // life of the server.
  browserPromise ??= (async () => {
    const launched = await puppeteer.use(StealthPlugin()).launch({
      headless: opt?.headless ?? true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-extensions",
      ],
      // userDataDir: "./browser-data", // Specify a directory path
    });

    try {
      blocker = await PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch);
    } catch (err) {
      // Best-effort: the filter lists come from a CDN, and a bad response there
      // must not take down every browser-driven feature (extraction, snapshots,
      // imports). Pages still work, they just stop blocking ads.
      blocker = null;
      console.warn(
        "Ad blocker unavailable, continuing without it:",
        err instanceof Error ? err.message : err,
      );
    }

    return launched;
  })().catch((err) => {
    browserPromise = null; // a failed launch must not poison later attempts
    throw err;
  });

  return browserPromise;
}

/**
 * Outranks the ad blocker, which continues top-level documents at priority 0.
 * Puppeteer resolves interception cooperatively: the highest priority action
 * wins, and the blocker's handler returns early when another one has acted.
 */
const NAVIGATION_BLOCK_PRIORITY = 100;

/**
 * Refuse in-browser navigations to addresses the outbound policy rejects.
 *
 * Chromium resolves DNS and follows redirects on its own, so the per-call
 * `assertSafeOutboundUrl` only ever covered the entry URL: a public page
 * answering `302 Location: http://169.254.169.254/` had the internal document
 * rendered, returned by the snapshot route, and persisted as chapter content.
 * This check runs on the document itself, including every redirect hop.
 *
 * Subresources stay unfiltered — filtering them measurably changes page
 * behaviour, and they are not what gets saved as a chapter.
 *
 * `isAllowed` is injectable so tests can exercise the wiring without the
 * public internet.
 */
export async function guardNavigations(
  page: Page,
  options: { isAllowed?: (url: string) => boolean } = {},
) {
  const isAllowed = options.isAllowed ?? isAllowedOutboundUrl;

  await page.setRequestInterception(true);

  page.on("request", (request) => {
    const isDocument =
      request.isNavigationRequest() || request.resourceType() === "document";

    if (isDocument && !isAllowed(request.url())) {
      void request.abort("blockedbyclient", NAVIGATION_BLOCK_PRIORITY);
      return;
    }

    // Low priority on purpose: the ad blocker's decision (blocking a tracker,
    // or continuing a document) must win, and with no blocker this still lets
    // the request through.
    void request.continue(undefined, -1);
  });
}

export async function newBrowserPage(opt?: {
  blockResources?: boolean;
  headless?: boolean;
}) {
  const browser = await getBrowser({ headless: opt?.headless });
  const page = await browser.newPage();
  blocker?.enableBlockingInPage(page);

  if (opt?.blockResources) {
    blockResources.onPageCreated(page);
  }

  // Applied here rather than at each call site so no future page can skip it.
  await guardNavigations(page);

  return page;
}

async function loopUntil(
  page: Page,
  action: ActionWithLoopUntil,
  fn: () => Promise<void>,
) {
  const { loopUntil } = action;
  if (!loopUntil) {
    return await fn();
  }

  let attempts = 0;
  const maxAttempts = Math.min(loopUntil.attempts || 3, 20);
  let success = false;

  while (attempts < maxAttempts && !success) {
    attempts++;

    await fn();

    if (loopUntil.delay) {
      await waitFor(loopUntil.delay);
    }

    if (loopUntil.repeat) {
      if (attempts >= maxAttempts) {
        success = true;
      }
    }

    if (loopUntil.visible != null) {
      let res: ElementHandle<Element> | null = null;

      try {
        res = await page.waitForSelector(loopUntil.selector, {
          visible: loopUntil.visible,
          timeout: loopUntil.timeout,
        });
      } catch (err) {}

      if (res) {
        success = true;
      }
    }
  }

  if (!success) {
    throw new Error("Failed to execute loop until action");
  }
}

export async function execActions(
  page: Page,
  actions: Action[],
  opts?: { callback?: (action: Action) => Promise<void> },
) {
  for (const action of actions) {
    const { type, data } = action;

    if (type === "click") {
      await loopUntil(page, action, async () => {
        // await page.click(data.selector);

        // await page.evaluate((sel) => {
        //   const el = document.querySelector(sel) as HTMLAnchorElement;
        //   // el?.scrollIntoView();
        //   el?.click();
        // }, data.selector);

        const el = await page.$(data.selector);
        if (!el) {
          throw new Error("element not found");
        }

        await page.evaluate((sel) => {
          (document.querySelector(sel) as HTMLElement)?.scrollIntoView();
        }, data.selector);

        const box = await el.boundingBox();
        if (!box) {
          throw new Error("element not found");
        }

        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

        await waitFor(Math.max(data.waitFor || 0, 500));
      });
    }

    if (type === "scroll") {
      await loopUntil(page, action, async () => {
        await page.evaluate(
          (data) => window.scrollTo(data.x || 0, data.y || 0),
          data,
        );
        await waitFor(500);
      });
    }

    if (type === "wait") {
      switch (data.until) {
        case "domcontentloaded":
        case "networkidle0":
        case "networkidle2":
          await page.waitForNavigation({
            waitUntil: data.until,
            timeout: data.timeout || 30000,
          });
          break;

        case "selector":
          if (!data.selector) {
            throw new Error("selector is required");
          }
          await page.waitForSelector(data.selector, {
            timeout: data.timeout || 30000,
            visible: data.visible,
          });
          break;

        case "timeout":
        default:
          if (data.ms) await waitFor(data.ms);
          else throw new Error(`Unknown wait until: ${data.until}`);
      }
    }

    if (type === "input") {
      await page.type(data.selector, data.text);
    }

    if (type === "block") {
      await page.evaluate((sel) => {
        let elements: NodeListOf<Element>;
        try {
          elements = document.querySelectorAll(sel);
        } catch {
          throw new Error(`invalid selector: ${sel}`);
        }
        elements.forEach((el) => el.remove());
      }, data.selector);
    }

    if (opts?.callback) {
      await opts.callback(action);
    }
  }
}
