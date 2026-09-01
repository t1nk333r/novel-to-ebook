import type { Kysely, Migration } from "kysely";

/**
 * Establishes a project-scoped uniqueness invariant on chapter order.
 *
 * Existing databases may already contain duplicate (or merely non-dense)
 * `(projectId, index)` pairs, since indices were historically allocated by
 * reading `MAX(index)` outside of a transaction. Before the unique index can
 * be created, every project's chapters are deterministically renumbered to a
 * dense, zero-based sequence that preserves their existing relative order
 * (ties broken by the chapter's own id, which reflects original insertion
 * order).
 */
export const Migration0002: Migration = {
  async up(db: Kysely<any>) {
    const rows = await db
      .selectFrom("project_chapters")
      .select(["id", "projectId", "index"])
      .orderBy("projectId", "asc")
      .orderBy("index", "asc")
      .orderBy("id", "asc")
      .execute();

    const nextIndexByProject = new Map<string, number>();

    for (const row of rows) {
      const nextIndex = nextIndexByProject.get(row.projectId) ?? 0;
      nextIndexByProject.set(row.projectId, nextIndex + 1);

      if (row.index !== nextIndex) {
        await db
          .updateTable("project_chapters")
          .set({ index: nextIndex })
          .where("id", "=", row.id)
          .execute();
      }
    }

    await db.schema
      .createIndex("project_chapters_project_id_index_unique")
      .on("project_chapters")
      .columns(["projectId", "index"])
      .unique()
      .execute();
  },

  async down(db: Kysely<any>) {
    await db.schema
      .dropIndex("project_chapters_project_id_index_unique")
      .execute();
  },
};
