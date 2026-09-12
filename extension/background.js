/**
 * The only place the API token is used.
 *
 * Requests are made from the service worker, not from a content script: a script
 * running beside the page is one bug away from handing the token to the page, and
 * a worker may fetch hosts the user has granted without CORS headers (the API
 * sends none).
 *
 * Nothing here logs the token, and nothing returns it to the popup.
 */

const API_PREFIX = "/api";

async function callApi(config, method, path, body) {
  if (!config?.serverUrl) throw new Error("Set the server URL first");
  // A loopback server enforces no token, so one is optional: the header is only
  // attached when the user has set it.

  const url = new URL(API_PREFIX + path, config.serverUrl.replace(/\/+$/, "") + "/");
  const response = await fetch(url, {
    method,
    headers: {
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();

  if (!response.ok) {
    // Status and the server's message only — never a body dump.
    let message = response.statusText;
    try {
      message = JSON.parse(text).message || message;
    } catch {
      // Non-JSON error page; the status is enough.
    }
    throw new Error(`${response.status}: ${message}`);
  }

  return text ? JSON.parse(text) : null;
}

const handlers = {
  async listProjects({ config }) {
    return callApi(config, "GET", "/projects");
  },

  async captureChapter({ config, projectId, title, html, url }) {
    return callApi(config, "POST", `/projects/${projectId}/chapters/capture`, {
      title,
      html,
      url,
    });
  },

  async importBook({ config, projectId, bookUrl, selector }) {
    return callApi(config, "POST", `/projects/${projectId}/chapters/import-book`, {
      bookUrl,
      selector,
    });
  },
};

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const handler = handlers[message?.type];
  if (!handler) {
    respond({ error: `unknown message: ${message?.type}` });
    return false;
  }

  handler(message)
    .then((result) => respond({ result }))
    .catch((error) => respond({ error: String(error?.message || error) }));

  return true; // keep the channel open for the async reply
});
