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
import { type Action, type ActionWithLoopUntil } from "../app/projects/schema";

let browser: Browser | null = null;
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
  if (!browser) {
    browser = await puppeteer.use(StealthPlugin()).launch({
      headless: opt?.headless ?? true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-extensions",
      ],
      // userDataDir: "./browser-data", // Specify a directory path
    });
    blocker = await PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch);
  }

  return browser;
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
