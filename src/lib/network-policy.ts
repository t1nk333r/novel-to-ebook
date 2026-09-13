import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HTTPError } from "./error";
import { limits } from "./limits";

type LookupAddress = { address: string; family: number };
type Lookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

export class UnsafeOutboundUrlError extends HTTPError {
  constructor(reason?: string) {
    super(reason ? `Outbound URL is not allowed: ${reason}` : "Outbound URL is not allowed", {
      status: 400,
      code: "UNSAFE_OUTBOUND_URL",
    });
  }
}

function ipv4Number(address: string) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0;
}

function ipv4InCidr(value: number, base: string, prefix: number) {
  const baseValue = ipv4Number(base)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function parseIpv6(address: string) {
  const zoneIndex = address.indexOf("%");
  const unzoned = (zoneIndex >= 0 ? address.slice(0, zoneIndex) : address).toLowerCase();
  const mappedMatch = unzoned.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let normalized = unzoned;
  if (mappedMatch) {
    const ipv4 = ipv4Number(mappedMatch[2]!);
    if (ipv4 == null) return null;
    normalized = `${mappedMatch[1]}${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InCidr(value: bigint, base: string, prefix: number) {
  const baseValue = parseIpv6(base)!;
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (baseValue >> shift);
}

export function isPublicIp(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address)!;
    const blocked: [string, number][] = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, prefix]) => ipv4InCidr(value, base, prefix));
  }

  if (family === 6) {
    const value = parseIpv6(address);
    if (value == null) return false;
    const mappedPrefix = parseIpv6("::ffff:0:0")! >> 32n;
    if ((value >> 32n) === mappedPrefix) {
      const mapped = Number(value & 0xffffffffn);
      const dotted = `${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`;
      return isPublicIp(dotted);
    }
    return ![
      ["::", 128],
      ["::1", 128],
      ["fc00::", 7],
      ["fe80::", 10],
      ["ff00::", 8],
      ["2001:db8::", 32],
    ].some(([base, prefix]) => ipv6InCidr(value, base as string, prefix as number));
  }

  return false;
}

/**
 * The DNS-free half of the outbound policy: scheme, embedded credentials,
 * `localhost`, and literal addresses. Shared by `assertSafeOutboundUrl` (which
 * adds resolution) and by `isAllowedOutboundUrl`.
 */
function parseOutboundUrl(input: string | URL) {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw new UnsafeOutboundUrlError(`"${String(input).slice(0, 80)}" is not a URL`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UnsafeOutboundUrlError(`only http(s) URLs are allowed (got "${url.protocol}")`);
  }

  if (url.username || url.password) {
    throw new UnsafeOutboundUrlError("URLs carrying credentials are not allowed");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new UnsafeOutboundUrlError(`"${hostname || "(empty)"}" is a local host`);
  }

  if (isIP(hostname) && !isPublicIp(hostname)) {
    throw new UnsafeOutboundUrlError(`"${hostname}" is a private address`);
  }

  return { url, hostname };
}

/**
 * Synchronous form of `assertSafeOutboundUrl` for callers that cannot await —
 * the EPUB generator's image hook is the reason this exists. Names are accepted
 * on their surface only: a hostname that resolves to a private address still
 * passes here, which is why this is not a substitute for the fetch paths.
 */
export function isAllowedOutboundUrl(input: string | URL) {
  try {
    parseOutboundUrl(input);
    return true;
  } catch {
    return false;
  }
}

export async function assertSafeOutboundUrl(
  input: string | URL,
  options?: { lookup?: Lookup },
) {
  const { url, hostname } = parseOutboundUrl(input);

  if (isIP(hostname)) return url;

  let addresses: LookupAddress[];
  try {
    addresses = await (options?.lookup || (dnsLookup as unknown as Lookup))(hostname, {
      all: true,
      verbatim: true,
    });
  } catch {
    throw new UnsafeOutboundUrlError(`"${hostname}" does not resolve`);
  }

  const privateAddresses = addresses
    .map(({ address }) => address)
    .filter((address) => !isPublicIp(address));
  if (!addresses.length || privateAddresses.length) {
    throw new UnsafeOutboundUrlError(
      privateAddresses.length
        ? `"${hostname}" resolves to ${privateAddresses.join(", ")} — a private address`
        : `"${hostname}" does not resolve`,
    );
  }
  return url;
}

function timeoutSignal(signal?: AbortSignal, timeoutMs = limits.fetchTimeoutMs) {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  options?: { lookup?: Lookup; maxRedirects?: number; timeoutMs?: number },
) {
  let url = await assertSafeOutboundUrl(input, options);
  const maxRedirects = options?.maxRedirects ?? limits.redirects;

  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: timeoutSignal(init.signal || undefined, options?.timeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    if (!location || redirects >= maxRedirects) {
      await response.body?.cancel();
      throw new UnsafeOutboundUrlError();
    }
    await response.body?.cancel();
    url = await assertSafeOutboundUrl(new URL(location, url), options);
  }
}

export async function readResponseBytes(
  response: Response,
  maximum = limits.fetchedBytes,
) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) {
    await response.body?.cancel();
    throw new HTTPError("Fetched resource is too large", {
      status: 413,
      code: "FETCH_TOO_LARGE",
    });
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new HTTPError("Fetched resource is too large", {
        status: 413,
        code: "FETCH_TOO_LARGE",
      });
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
