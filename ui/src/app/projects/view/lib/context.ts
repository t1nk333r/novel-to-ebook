import type { JsonRes } from "@/lib/api";
import { createContext, useContext } from "react";

// The generated response type carries the real config shape; the hand-written
// `fontDecryptMap: string` override that used to live here contradicted the
// server (a JSON string instead of a record) and turned the font-decrypt save
// into a rejected request.
type Project = JsonRes<"/projects/{id}", "get">;

export const ProjectContext = createContext<{
  project: Project;
}>(null!);

export function useProjectContext() {
  return useContext(ProjectContext)!;
}
