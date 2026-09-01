import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Some tests exercise real repository/route code that transitively imports
// `src/db/index.ts`, which throws at module load if DATABASE_URL is unset.
// Point it at a scratch, per-run sqlite file so tests never touch real user
// data and never require a `.env` in the repo.
if (!process.env.DATABASE_URL) {
  const dir = mkdtempSync(join(tmpdir(), "storvi-test-"));
  process.env.DATABASE_URL = join(dir, "test.sqlite");
}
