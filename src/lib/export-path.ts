import fs from "node:fs/promises";
import path from "node:path";
import { HTTPError } from "./error";

export type ExportDestination = {
  directory: string;
  fullPath: string;
  key: string;
  filename: string;
};

function invalidExportPath() {
  return new HTTPError("Invalid export destination", {
    status: 400,
    code: "INVALID_EXPORT_PATH",
  });
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolveExportDestination(
  dataRoot: string,
  title: string,
  outDir?: string | null,
): Promise<ExportDestination> {
  const cleanTitle = title.trim();
  if (
    !cleanTitle ||
    cleanTitle === "." ||
    cleanTitle === ".." ||
    /[\\/\0\r\n]/.test(cleanTitle)
  ) {
    throw invalidExportPath();
  }

  const relativeDir = outDir?.trim() || "";
  if (
    path.isAbsolute(relativeDir) ||
    relativeDir.split(/[\\/]+/).some((part) => part === "..") ||
    /[\0\r\n]/.test(relativeDir)
  ) {
    throw invalidExportPath();
  }

  const root = path.resolve(dataRoot);
  await fs.mkdir(root, { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  const directory = path.resolve(canonicalRoot, relativeDir);
  if (!isWithin(canonicalRoot, directory)) throw invalidExportPath();

  await fs.mkdir(directory, { recursive: true });
  const canonicalDirectory = await fs.realpath(directory);
  if (!isWithin(canonicalRoot, canonicalDirectory)) throw invalidExportPath();

  const filename = `${cleanTitle}.epub`;
  const fullPath = path.join(canonicalDirectory, filename);
  if (!isWithin(canonicalRoot, fullPath)) throw invalidExportPath();

  return {
    directory: canonicalDirectory,
    fullPath,
    filename,
    key: path.relative(canonicalRoot, fullPath).replaceAll("\\", "/"),
  };
}
