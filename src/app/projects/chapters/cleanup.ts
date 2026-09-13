import db from "../../../db";
import { resolveAiProvider } from "../../../lib/ai-provider";
import {
  applyCleanup,
  cleanupCandidates,
  cleanupModelFromEnv,
  decideCleanupWithMistral,
  deterministicJunk,
  hasFurniture,
  splitChapterBlocks,
  type ChapterBlocks,
} from "../../../lib/chapter-clean";
import type { TaskContext } from "../../../lib/queue-mgr";
import { getProjectConfig, updateProjectConfig } from "../utils";
import { importQueue } from "./context";

/**
 * Chapter cleanup: strip what the publisher wrapped around the prose.
 *
 * Runs on the same queue as imports so the existing progress stream reports it —
 * `GET /projects/:id/chapters/import` is namespace-filtered by project, and the
 * UI already displays it. No browser is needed; the only cost is the model, which
 * sees a page of block excerpts per chapter rather than the chapter itself.
 */

export type CleanupReport = {
  chapters: number;
  cleaned: number;
  removed: number;
  refused: number;
  skipped: number;
};

export function queueCleanChapters(payload: {
  projectId: string;
  maxChapters?: number;
  dryRun?: boolean;
}) {
  const { projectId, maxChapters, dryRun } = payload;

  return importQueue.add(async (ctx: TaskContext) => {
    const chapters = await db
      .selectFrom("project_chapters")
      .select(["id", "title", "content"])
      .where("projectId", "=", projectId)
      .orderBy("index", "asc")
      .execute();

    if (chapters.length === 0) {
      ctx.setProgress(100, "No chapters to clean");
      return;
    }

    const config = await getProjectConfig(projectId);
    const alreadyCleaned = new Set(config.cleanedChapterIds ?? []);
    // "Cleaned" records an attempt, not a guarantee: a chapter refused by the
    // removal cap, or one whose note sits inside a paragraph, is still dirty and
    // must be offered again — otherwise a better pass can never reach it.
    const pending = chapters.filter(
      (chapter) =>
        !alreadyCleaned.has(String(chapter.id)) || hasFurniture(chapter.content),
    );
    const limit = maxChapters ?? pending.length;
    const batch = pending.slice(0, limit);

    if (batch.length === 0) {
      ctx.setProgress(100, "Every chapter is already clean");
      return;
    }

    const provider = resolveAiProvider();
    const useAi = provider.provider === "mistral";
    const model = cleanupModelFromEnv();
    const report: CleanupReport = {
      chapters: batch.length,
      cleaned: 0,
      removed: 0,
      refused: 0,
      skipped: 0,
    };
    const cleanedIds = new Set(alreadyCleaned);

    ctx.setProgress(
      0,
      useAi
        ? `Cleaning ${batch.length} chapter(s) with ${model}${dryRun ? " (dry run)" : ""}`
        : `Cleaning ${batch.length} chapter(s) without AI — only obvious furniture`,
    );

    for (const [position, chapter] of batch.entries()) {
      const html = chapter.content ?? "";
      const blocks: ChapterBlocks = splitChapterBlocks(html);

      try {
        // Provable furniture first, so the model is asked only about the
        // ambiguous blocks — and so a run with no AI still cleans these.
        const certain = deterministicJunk(blocks);
        const candidates = cleanupCandidates(blocks, certain);

        let drop = certain;
        let spans: string[] = [];
        let refused: string | null = null;

        if (useAi && candidates.length > 0) {
          const decision = await decideCleanupWithMistral(chapter.title, blocks, candidates, {
            apiKey: provider.mistralKey,
            model,
          });
          drop = [...certain, ...decision.drop];
          spans = decision.spans;
        }

        const applied = applyCleanup(blocks, drop, undefined, spans, certain);
        refused = applied.refused;

        if (refused) {
          report.refused++;
          console.warn(
            `cleanup: left "${chapter.title}" untouched — ${refused}`,
          );
        } else if (!dryRun && applied.dropped.length > 0) {
          await db
            .updateTable("project_chapters")
            .set({ content: applied.html })
            .where("id", "=", chapter.id)
            .execute();
        }

        if (!refused) {
          report.cleaned++;
          report.removed += applied.dropped.length + applied.spans;
        }

        if (!dryRun && !refused) {
          cleanedIds.add(String(chapter.id));
          await updateProjectConfig(projectId, { cleanedChapterIds: [...cleanedIds] });
        }
      } catch (error) {
        report.skipped++;
        // Status and title only: a provider error body can echo content.
        console.warn(
          `cleanup: skipped "${chapter.title}" — ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      ctx.setProgress(
        ((position + 1) / batch.length) * 100,
        `${report.cleaned} cleaned, ${report.removed} removal(s)` +
          (report.refused ? `, ${report.refused} refused` : "") +
          (report.skipped ? `, ${report.skipped} skipped` : ""),
      );
    }

    ctx.setProgress(
      100,
      `${dryRun ? "Would clean" : "Cleaned"} ${report.cleaned}/${report.chapters} chapter(s), ` +
        `${report.removed} removal(s)` +
        (report.refused ? `, ${report.refused} refused by the removal cap` : "") +
        (report.skipped ? `, ${report.skipped} skipped` : ""),
    );
  }, { namespace: projectId });
}
