import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export type ServerConfig = {
  host: string;
  port: number;
  apiToken?: string;
  remote: boolean;
  insecureBind: boolean;
};

function isEnabled(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(value?.trim() || "");
}

export function isLoopbackHost(host: string) {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function resolveServerConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = Number(env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const remote = !isLoopbackHost(host);
  const apiToken = env.API_TOKEN?.trim() || undefined;

  // A container must bind 0.0.0.0 to be reachable through a published port, so
  // HOST looks remote even when that port is published only to the host's
  // loopback interface. ALLOW_INSECURE_BIND is the operator asserting that an
  // outer boundary (Docker port publishing, a reverse proxy) supplies the
  // containment API_TOKEN would otherwise supply. It never disables bearerAuth:
  // a token that is set is still enforced.
  const insecureBind = isEnabled(env.ALLOW_INSECURE_BIND);
  if (remote && !apiToken && !insecureBind) {
    throw new Error(
      "API_TOKEN is required when HOST is not loopback. Set ALLOW_INSECURE_BIND=1 only when the port is reachable solely from this machine, for example a Docker port published to 127.0.0.1.",
    );
  }

  return { host, port, apiToken, remote, insecureBind };
}

function tokenMatches(actual: string | undefined, expected: string) {
  const actualBytes = Buffer.from(actual || "");
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

export function bearerAuth(apiToken: string): MiddlewareHandler {
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;

    if (!tokenMatches(token, apiToken)) {
      return c.json(
        { error: true, message: "Unauthorized", code: "UNAUTHORIZED" },
        401,
      );
    }

    await next();
  };
}
