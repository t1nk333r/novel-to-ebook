import { Hono } from "hono";
import { proxy } from "hono/proxy";
// import { showRoutes } from "hono/dev";
import { createOpenApiDocument } from "hono-zod-openapi";
import { HTTPException } from "hono/http-exception";
import { Scalar } from "@scalar/hono-api-reference";
import { initScheduler } from "./scheduler";
import { runMigration } from "./db/migrate";
import { serveStatic } from "hono/bun";

import projects from "./app/projects/routes";
import library from "./app/library/routes";
import utility from "./app/utility/routes";
import { waitFor } from "./lib/utils";
import { bearerAuth, resolveServerConfig } from "./lib/auth";
import { limits } from "./lib/limits";
import { assertSafeOutboundUrl } from "./lib/network-policy";

const serverConfig = resolveServerConfig();
const api = new Hono();

api.use("*", async (c, next) => {
  const length = Number(c.req.header("content-length") || 0);
  if (length > limits.requestBodyBytes) return c.json({ error: true, message: "Request body too large", code: "REQUEST_TOO_LARGE" }, 413);
  await next();
});
if (serverConfig.remote && serverConfig.apiToken) api.use("*", bearerAuth(serverConfig.apiToken));

// api.use("*", async (_, next) => {
//   // simulate network delay
//   await waitFor(1000 + Math.random() * 2000);
//   return next();
// });

api.onError((error, c) => {
  let message = error.message;
  let status = 500;
  let code: string | undefined = undefined;

  if (error instanceof HTTPException) {
    message = error.message;
    status = error.status;
  }

  if ("code" in error) {
    code = error.code as string;
  }

  return c.json({ error: true, message, code }, status as never);
});

// App routes
api.route("/projects", projects);
api.route("/library", library);
api.route("/utility", utility);

// CORS Proxy
api.get("/proxy/*", async (c) => {
  const url = new URL(c.req.url);
  const target = url.pathname.replace("/proxy/", "");
  const safeTarget = await assertSafeOutboundUrl(target);
  return proxy(safeTarget.toString());
});

// API docs
if (process.env.NODE_ENV !== "production") {
  createOpenApiDocument(
    api,
    {
      info: {
        title: "Storvi API",
        version: "1.0.0",
      },
    },
    { routeName: "openapi.json" },
  );
  api.get(
    "/doc",
    Scalar({
      url: "/openapi.json",
      defaultHttpClient: { targetKey: "node", clientKey: "fetch" },
    }),
  );
  // showRoutes(api);
}

const app = new Hono();
app.route("/api", api);
app.get("*", serveStatic({ root: "./ui/dist" }));

const PORT = serverConfig.port;
const HOST = serverConfig.host;

await runMigration();
initScheduler();
if (serverConfig.remote && !serverConfig.apiToken) {
  console.warn(
    `WARNING: bound to ${HOST} with no API_TOKEN (ALLOW_INSECURE_BIND is set). Anyone who can reach this port has full API access. Publish it to loopback only.`,
  );
}
console.log(`Listening on http://${HOST}:${PORT}`);

Bun.serve({
  fetch: app.fetch,
  idleTimeout: 255,
  hostname: HOST,
  port: PORT,
  development: process.env.NODE_ENV !== "production",
});
