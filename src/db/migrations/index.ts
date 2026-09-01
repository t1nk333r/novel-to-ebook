import type { Migration } from "kysely";
import { Migration0001 } from "./0001-init";
import { Migration0002 } from "./0002-chapter-order-unique";

export const migrations: Record<string, Migration> = {
  "0001": Migration0001,
  "0002": Migration0002,
};
