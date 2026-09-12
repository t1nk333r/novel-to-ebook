import type { paths } from "./api.schema";
import { API_URL, type JsonBody } from "./api";
import { apiAuthHeader } from "./api-auth";
import { getApiToken, reportUnauthorized } from "@/stores/auth.store";

export async function streamSSE<
  TKey extends keyof paths,
  TMethod extends "get" | "post" | "put" | "delete" = "get",
>(
  url: TKey,
  method?: TMethod,
  options?: Omit<RequestInit, "body"> & {
    body?: JsonBody<TKey, TMethod>;
    onMessage: (event: string, data: any) => void;
  },
) {
  const { onMessage, body, headers, ...opts } = options || {};

  const target = API_URL + url;
  const res = await fetch(target, {
    ...opts,
    method,
    body: typeof body === "object" ? JSON.stringify(body) : body,
    headers: {
      "Content-Type": typeof body === "object" ? "application/json" : undefined,
      ...(headers || {}),
      ...apiAuthHeader(target, window.location.origin, getApiToken()),
    },
    responseType: "stream",
  } as never);
  if (res.status === 401) reportUnauthorized();
  if (!res.ok) throw new Error(res.statusText);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let error: Error | null = null;

  while (!error) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const { event, data } = parseSSE(part);

      if (event === "error" && "message" in data) {
        error = new Error(data.message);
        reader.cancel();
        break;
      }

      onMessage?.(event, data);
    }
  }

  if (error) throw error;
}

function parseSSE(chunk: string) {
  const lines = chunk.split("\n");

  let event = "message";
  let data = "";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }

    if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    }
  }

  return { event, data: JSON.parse(data) };
}
