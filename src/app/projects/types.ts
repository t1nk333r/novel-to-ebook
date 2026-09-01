import type z from "zod";
import type { ProjectConfigSchema } from "./schema";

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
