import { captureChapter, guessContentSelector, pickContentSelector } from "./content.js";

/**
 * The popup: configuration, target page, and the three actions.
 *
 * Everything that talks to the server goes through the background worker, so the
 * token never enters this document's storage calls or the page.
 */

const $ = (id) => document.getElementById(id);

let config = { serverUrl: "", token: "" };
let projects = [];
let tabs = [];

const status = (message, kind = "") => {
  const node = $("status");
  node.textContent = message;
  node.className = kind;
};

/** Every handler runs through this, so a failure is reported rather than swallowed. */
const guard = (handler) => async (event) => {
  try {
    await handler(event);
  } catch (error) {
    status(String(error?.message || error), "error");
  }
};

const send = (message) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (reply) => {
      if (chrome.runtime.lastError) return resolve({ error: chrome.runtime.lastError.message });
      resolve(reply ?? { error: "no reply" });
    });
  });

async function loadConfig() {
  const stored = await chrome.storage.local.get(["serverUrl", "token"]);
  config = { serverUrl: stored.serverUrl || "", token: stored.token || "" };

  // This lands a few milliseconds after the popup opens, so it must not wipe a
  // value that is already in the field — the stored value is only the default.
  if (!$("serverUrl").value) $("serverUrl").value = config.serverUrl;
  if (!$("token").value) $("token").value = config.token;
}

async function loadTabs() {
  const all = await chrome.tabs.query({});
  tabs = all
    .filter((tab) => /^https?:/.test(tab.url || ""))
    .sort((a, b) => Number(b.active) - Number(a.active) || Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));

  $("tab").innerHTML = "";
  for (const tab of tabs) {
    const option = document.createElement("option");
    option.value = String(tab.id);
    option.textContent = `${tab.active ? "• " : ""}${(tab.title || tab.url || "").slice(0, 48)}`;
    $("tab").append(option);
  }

  await loadSelectorForCurrentTab();
}

function currentTab() {
  const id = Number($("tab").value);
  return tabs.find((tab) => tab.id === id) || tabs[0] || null;
}

function hostOf(tab) {
  try {
    return new URL(tab.url).host;
  } catch {
    return "";
  }
}

const selectorKey = (tab) => `selector:${hostOf(tab)}`;

async function loadSelectorForCurrentTab() {
  const tab = currentTab();
  if (!tab) {
    $("selector").value = "";
    return;
  }

  const stored = await chrome.storage.local.get(selectorKey(tab));
  $("selector").value = stored[selectorKey(tab)] || "";
}

async function saveSelector(tab, selector) {
  await chrome.storage.local.set({ [selectorKey(tab)]: selector });
  $("selector").value = selector;
}

async function loadProjects() {
  const select = $("project");

  if (!config.serverUrl) {
    select.innerHTML = '<option value="">— set the server URL first —</option>';
    return;
  }

  // No token check: a loopback server needs none, and a server that does require
  // one answers 401, which is better feedback than refusing to try.
  const reply = await send({ type: "listProjects", config });
  if (reply.error) {
    select.innerHTML = '<option value="">— could not reach the server —</option>';
    status(`Could not list projects: ${reply.error}`, "error");
    return;
  }

  projects = reply.result || [];
  select.innerHTML = "";

  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.title;
    select.append(option);
  }

  const remembered = (await chrome.storage.local.get("projectId")).projectId;
  if (remembered && projects.some((project) => project.id === remembered)) {
    select.value = remembered;
  }

  status(projects.length ? "" : "No projects yet — create one in the web UI first");
}

async function inject(tabId, func, args) {
  const [first] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return first?.result;
}

$("save").addEventListener("click", guard(async () => {
  const serverUrl = $("serverUrl").value.trim().replace(/\/+$/, "");
  const token = $("token").value.trim();

  try {
    const origin = new URL(serverUrl).origin + "/*";
    // Loopback is granted by the manifest, so a local server never prompts.
    const already = await chrome.permissions.contains({ origins: [origin] });
    if (!already) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        status("Permission for that server was declined, so requests would fail", "error");
        return;
      }
    }
  } catch {
    status("That server URL is not valid", "error");
    return;
  }

  config = { serverUrl, token };
  await chrome.storage.local.set({ serverUrl, token });
  status("Saved", "ok");
  await loadProjects();
}));

$("project").addEventListener("change", guard(async () => {
  await chrome.storage.local.set({ projectId: $("project").value });
}));

$("tab").addEventListener("change", guard(loadSelectorForCurrentTab));

$("pick").addEventListener("click", guard(async () => {
  const tab = currentTab();
  if (!tab) return status("No web page open", "error");

  // The popup closes when the user clicks into the page, so the selector is
  // stored before reporting back.
  status("Click the content in the page…");
  const selector = await inject(tab.id, pickContentSelector);

  if (!selector) return status("Picking cancelled");
  await saveSelector(tab, selector);
  status(`Selector saved for ${hostOf(tab)}: ${selector}`, "ok");
}));

async function resolveSelector(tab) {
  const typed = $("selector").value.trim();
  if (typed) return typed;

  const guessed = await inject(tab.id, guessContentSelector);
  if (!guessed) return null;

  await saveSelector(tab, guessed);
  return guessed;
}

$("send").addEventListener("click", guard(async () => {
  const tab = currentTab();
  const projectId = $("project").value;
  if (!tab) return status("No web page open", "error");
  if (!projectId) return status("Pick a project", "error");

  status("Capturing…");
  const selector = await resolveSelector(tab);
  if (!selector) return status("No content found — use Pick content", "error");

  const capture = await inject(tab.id, captureChapter, [selector]);
  if (!capture || capture.error) return status(capture?.error || "Capture failed", "error");

  status(`Sending "${capture.title.slice(0, 40)}" (${capture.html.length} bytes)…`);
  const reply = await send({ type: "captureChapter", config, projectId, ...capture });

  if (reply.error) return status(`Failed: ${reply.error}`, "error");
  status(`Added: ${reply.result.title}`, "ok");
}));

$("book").addEventListener("click", guard(async () => {
  const tab = currentTab();
  const projectId = $("project").value;
  if (!tab) return status("No web page open", "error");
  if (!projectId) return status("Pick a project", "error");

  const selector = $("selector").value.trim();
  if (!selector) return status("Pick the content selector first", "error");

  status("Starting the whole-book import…");
  const reply = await send({
    type: "importBook",
    config,
    projectId,
    bookUrl: tab.url,
    selector,
  });

  if (reply.error) return status(`Failed: ${reply.error}`, "error");
  status("Importing — watch progress in the project's sidebar", "ok");
}));

await loadConfig();
await loadTabs();
await loadProjects();
