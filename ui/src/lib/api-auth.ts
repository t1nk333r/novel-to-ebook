export const API_PREFIX = "/api";

/**
 * True only for same-origin `/api` requests.
 *
 * The bearer token must never ride along on a cross-origin fetch: `OfflineImage`
 * is also used with arbitrary remote image URLs, and leaking the token to a
 * third-party host would hand over full control of this deployment.
 *
 * This module intentionally imports nothing so the root `bun test` suite can
 * import it by relative path.
 */
export function isApiRequest(url: string, origin: string): boolean {
  let base: URL;
  let target: URL;
  try {
    base = new URL(origin);
    target = new URL(url, base);
  } catch {
    return false;
  }

  if (target.origin !== base.origin) return false;
  return (
    target.pathname === API_PREFIX ||
    target.pathname.startsWith(`${API_PREFIX}/`)
  );
}

export function apiAuthHeader(
  url: string,
  origin: string,
  token: string | null | undefined,
): { Authorization: string } | undefined {
  const trimmed = token?.trim();
  if (!trimmed) return undefined;
  if (!isApiRequest(url, origin)) return undefined;
  return { Authorization: `Bearer ${trimmed}` };
}
