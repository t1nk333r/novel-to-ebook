/**
 * Which project produced this library book?
 *
 * The library lists files; the work (chapters, cleanup, export) lives in a
 * project. Without this, clicking a book only ever opened the reader — there was
 * no way back to the project that made it.
 *
 * Exact when the project recorded the file it exported. Otherwise the filename
 * and the project title are compared, because books exported before that was
 * recorded still deserve the link, and a re-export of the same title gets a
 * numeric suffix ("Title 2.epub").
 */

export type ProjectRef = {
  id: string;
  title: string;
  config?: { exportedKeys?: string[] | null } | null;
};

/** "Berserk of Gluttony 2.epub" -> "berserk of gluttony" */
function normalize(value: string) {
  return value
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/\s+\d+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function matchProjectForKey(key: string, projects: ProjectRef[]): ProjectRef | null {
  const recorded = projects.find((project) =>
    (project.config?.exportedKeys ?? []).includes(key),
  );
  if (recorded) return recorded;

  const wanted = normalize(key);
  if (!wanted) return null;
  return projects.find((project) => normalize(project.title) === wanted) ?? null;
}
