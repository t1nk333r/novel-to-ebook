import OfflineImage from "@/components/offline-image";
import { useState } from "react";

type Props = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string | null;
};

/**
 * A project cover is either a URL the operator pasted or an image this server
 * stores for them.
 *
 * The two need opposite treatments. A stored cover lives behind the bearer token
 * on our own /api, and an <img src> cannot send a header — the phone would 401 —
 * so it goes through `OfflineImage`, which fetches it and hands back a blob. A
 * third-party URL keeps the plain <img>: nothing is fetched by our code, so no
 * token is ever offered to another host.
 */
export default function ProjectCover({ src, ...props }: Props) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) return null;
  if (src.startsWith("/")) return <OfflineImage src={src} {...props} />;

  return <img src={src} onError={() => setFailed(true)} {...props} />;
}
