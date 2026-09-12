import { FontDecryptor } from "../../lib/font-decryptor";
import { readResponseBytes, safeFetch } from "../../lib/network-policy";

export async function decryptTextFromFont(
  text: string[],
  opt?: { fontUrl?: string | null; decryptMap?: string | null },
) {
  const { fontUrl, decryptMap } = opt || {};
  if (!decryptMap && !fontUrl) {
    throw new Error("Either decryptMap or fontUrl is required");
  }
  let decryptor: FontDecryptor | null = null;

  if (decryptMap) {
    decryptor = FontDecryptor.fromMap(JSON.parse(decryptMap));
  } else if (fontUrl) {
    // A bare fetch here was the one outbound path outside the plan-005 policy:
    // `fontUrl` arrives from the client on /utility/font-decrypt and from the
    // font URLs a scraped page loaded, so it can point at loopback, LAN hosts,
    // metadata endpoints, or a `file:`/`data:` scheme. safeFetch validates the
    // scheme, host (per redirect hop) and deadline; readResponseBytes caps the
    // body. Fonts are far below the cap.
    const res = await safeFetch(fontUrl);
    const buf = await readResponseBytes(res);
    decryptor = await FontDecryptor.fromBuffer(Buffer.from(buf));
  }

  if (!decryptor) {
    throw new Error("Failed to build decryptor");
  }

  const result = text.map((t) => decryptor.decrypt(t));

  return { map: decryptor.map, result };
}
