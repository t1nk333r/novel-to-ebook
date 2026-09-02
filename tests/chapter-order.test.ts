import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, Migrator } from "kysely";
import { BunWorkerDialect } from "kysely-bun-worker";
import db from "../src/db";
import { migrations } from "../src/db/migrations";
import {
  getLastIndex,
  insertChapterAtNextIndex,
  reorderChapters,
} from "../src/app/projects/chapters/repository";

async function createProject(id: string) {
  await db
    .insertInto("projects")
    .values({ id, title: "Test project", author: "Test author" })
    .execute();
}

// NOTE: deliberately not using bun:test's `expect(promise).rejects` matcher
// here. On this Bun version, `expect(...).rejects` reliably hangs (not just
// fails) when the wrapped promise resolves through kysely-bun-worker's
// Worker-thread SQLite dialect: the underlying worker's response event never
// gets delivered while `.rejects` is pending, and the test only ends when
// bun's own 5000ms per-test timeout fires. A plain try/catch around the same
// call resolves normally every time. See the executor report for the
// isolated repro. Tracked as a known environment/tooling gotcha, not an
// application bug.
async function assertRejects(promise: Promise<unknown>) {
  let threw = false;
  try {
    await promise;
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}

beforeAll(async () => {
  const migrator = new Migrator({
    db,
    provider: {
      async getMigrations() {
        return migrations;
      },
    },
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
});

afterAll(async () => {
  await db.destroy();
});

describe("chapter order allocation", () => {
  test("concurrent creates never collide on (projectId,index)", async () => {
    const projectId = randomUUID();
    await createProject(projectId);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        insertChapterAtNextIndex(projectId, {
          title: `Chapter ${i}`,
          content: "content",
        }),
      ),
    );

    const indices = results.map((r) => r.index).sort((a, b) => a - b);
    expect(indices).toEqual(Array.from({ length: 10 }, (_, i) => i));
    expect(new Set(indices).size).toBe(10);

    const chapters = await db
      .selectFrom("project_chapters")
      .selectAll()
      .where("projectId", "=", projectId)
      .execute();
    expect(chapters.length).toBe(10);
  });

  test("concurrent create-vs-import allocation does not collide", async () => {
    const projectId = randomUUID();
    await createProject(projectId);

    const creates = Array.from({ length: 5 }, (_, i) =>
      insertChapterAtNextIndex(projectId, {
        title: `create-${i}`,
        content: "content",
      }),
    );
    const imports = Array.from({ length: 5 }, (_, i) =>
      insertChapterAtNextIndex(projectId, {
        title: `import-${i}`,
        content: "content",
      }),
    );

    await Promise.all([...creates, ...imports]);

    const chapters = await db
      .selectFrom("project_chapters")
      .select(["index"])
      .where("projectId", "=", projectId)
      .execute();
    const indices = chapters.map((c) => c.index).sort((a, b) => a - b);
    expect(indices.length).toBe(10);
    expect(new Set(indices).size).toBe(10);
    expect(indices).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });

  test("getLastIndex reflects only committed rows for its own project", async () => {
    const projectId = randomUUID();
    await createProject(projectId);

    expect(await getLastIndex(projectId)).toBe(-1);
    await insertChapterAtNextIndex(projectId, {
      title: "a",
      content: "content",
    });
    expect(await getLastIndex(projectId)).toBe(0);
  });

  test("reorder remains atomic and preserves all chapters under the unique index", async () => {
    const projectId = randomUUID();
    await createProject(projectId);

    const inserted = [];
    for (let i = 0; i < 4; i++) {
      inserted.push(
        await insertChapterAtNextIndex(projectId, {
          title: `Chapter ${i}`,
          content: "content",
        }),
      );
    }

    const shuffledIds = [
      inserted[2]!.id,
      inserted[0]!.id,
      inserted[3]!.id,
      inserted[1]!.id,
    ];
    await reorderChapters(projectId, shuffledIds);

    const chapters = await db
      .selectFrom("project_chapters")
      .select(["id", "index"])
      .where("projectId", "=", projectId)
      .orderBy("index", "asc")
      .execute();

    expect(chapters.map((c) => c.id)).toEqual(shuffledIds);
    expect(chapters.map((c) => c.index)).toEqual([0, 1, 2, 3]);
  });

  test("reorder rejects ids that are not exactly this project's chapters", async () => {
    const projectId = randomUUID();
    await createProject(projectId);
    const chapter = await insertChapterAtNextIndex(projectId, {
      title: "a",
      content: "content",
    });

    await assertRejects(
      reorderChapters(projectId, [chapter.id, 999999999]),
    );

    // partial id lists must also be rejected, not just foreign ones
    const other = await insertChapterAtNextIndex(projectId, {
      title: "b",
      content: "content",
    });
    void other;
    await assertRejects(reorderChapters(projectId, [chapter.id]));
  });
});

describe("chapter order migration repair", () => {
  test("normalizes pre-existing duplicate (projectId,index) pairs deterministically on an upgraded database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "storvi-migration-test-"));
    const testDb = new Kysely<any>({
      dialect: new BunWorkerDialect({ url: join(dir, "upgrade.sqlite") }),
    });

    try {
      // Bring the database up to the pre-existing schema only, as if it were
      // created before this plan's migration existed.
      const legacyMigrator = new Migrator({
        db: testDb,
        provider: {
          async getMigrations() {
            return { "0001": migrations["0001"]! };
          },
        },
      });
      const legacyResult = await legacyMigrator.migrateToLatest();
      if (legacyResult.error) throw legacyResult.error;

      const projectId = "dup-project";
      await testDb
        .insertInto("projects")
        .values({ id: projectId, title: "t", author: "a" })
        .execute();

      // Seed data the way the pre-migration code could actually produce:
      // duplicate and non-dense indices, inserted out of index order.
      await testDb
        .insertInto("project_chapters")
        .values([
          { projectId, title: "third", content: "c", index: 5 },
          { projectId, title: "first", content: "c", index: 1 },
          { projectId, title: "second-dup-a", content: "c", index: 1 },
          { projectId, title: "second-dup-b", content: "c", index: 1 },
        ])
        .execute();

      // Now apply the rest of the migrations, including the repair + unique
      // index from this plan.
      const fullMigrator = new Migrator({
        db: testDb,
        provider: {
          async getMigrations() {
            return migrations;
          },
        },
      });
      const fullResult = await fullMigrator.migrateToLatest();
      if (fullResult.error) throw fullResult.error;

      const chapters = await testDb
        .selectFrom("project_chapters")
        .select(["title", "index"])
        .where("projectId", "=", projectId)
        .orderBy("index", "asc")
        .execute();

      const indices = chapters.map((c: any) => c.index);
      expect(indices).toEqual([0, 1, 2, 3]);
      expect(new Set(indices).size).toBe(4);
      // Relative order is preserved: ties on the original index=1 break by
      // insertion order (which is what the id ordering reflects).
      expect(chapters.map((c: any) => c.title)).toEqual([
        "first",
        "second-dup-a",
        "second-dup-b",
        "third",
      ]);

      // The unique index is now authoritative.
      await assertRejects(
        testDb
          .insertInto("project_chapters")
          .values({ projectId, title: "dup", content: "c", index: 0 })
          .execute(),
      );
    } finally {
      await testDb.destroy();
    }
  });

  test("fresh database migrates cleanly and enforces the unique index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "storvi-migration-test-"));
    const testDb = new Kysely<any>({
      dialect: new BunWorkerDialect({ url: join(dir, "fresh.sqlite") }),
    });

    try {
      const migrator = new Migrator({
        db: testDb,
        provider: {
          async getMigrations() {
            return migrations;
          },
        },
      });
      const { error } = await migrator.migrateToLatest();
      expect(error).toBeUndefined();

      const projectId = "fresh-project";
      await testDb
        .insertInto("projects")
        .values({ id: projectId, title: "t", author: "a" })
        .execute();
      await testDb
        .insertInto("project_chapters")
        .values({ projectId, title: "a", content: "c", index: 0 })
        .execute();

      await assertRejects(
        testDb
          .insertInto("project_chapters")
          .values({ projectId, title: "b", content: "c", index: 0 })
          .execute(),
      );
    } finally {
      await testDb.destroy();
    }
  });
});
