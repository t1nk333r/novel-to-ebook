import { z } from "zod";
import { limits } from "../../lib/limits";

const boundedSelector = z.string().min(1).max(limits.selectorLength);

/**
 * One content selector, or several. Picked elements arrive as a list; a
 * hand-typed value arrives as a string and is normalized here so every consumer
 * downstream sees a list. Existing callers that sent a single string keep
 * working unchanged.
 */
export const contentSelectorList = z
  .union([
    boundedSelector,
    boundedSelector.array().min(1).max(limits.contentSelectors),
  ])
  .transform((value) => (Array.isArray(value) ? value : [value]));

export const SelectorSchema = z.object({
  title: z.string().min(1),
  chapter: z.string().nullish(),
  isChapterInTitle: z.boolean().nullish(),
  titleSeparator: z.string().nullish(),
  content: contentSelectorList,
  // CSS selector of each <iframe> from the main frame down to the frame the
  // content lives in. Absent or empty means the main frame, so payloads written
  // before frames were supported keep working untouched.
  framePath: z.string().min(1).array().max(limits.frames).optional(),
  urls: z
    .object({
      nextChapter: z.string().nullish(),
      prevChapter: z.string().nullish(),
    })
    .nullish(),
});

export type Selector = z.infer<typeof SelectorSchema>;

export const selectorExample: Selector = {
  title: "h1.title",
  chapter: "h2.chapter",
  isChapterInTitle: true,
  titleSeparator: "-",
  content: ["div.reading-content"],
  urls: {
    nextChapter: null,
    prevChapter: "a.prev-chapter",
  },
};

export const LoopUntilSchema = z.object({
  repeat: z.boolean().nullish(),
  visible: z.boolean().nullish(),
  selector: boundedSelector,
  timeout: z.number().int().min(1).max(limits.actionDelayMs).optional(),
  attempts: z.number().int().min(1).max(limits.actionAttempts).optional(),
  delay: z.number().int().min(0).max(limits.actionDelayMs).optional(),
});

const actionWithLoopUntil = z.object({
  loopUntil: LoopUntilSchema.nullish(),
});

export type ActionWithLoopUntil = z.infer<typeof actionWithLoopUntil>;

export const ClickActionSchema = actionWithLoopUntil.extend({
  type: z.literal("click"),
  data: z.object({
    selector: boundedSelector,
    waitFor: z.number().int().min(0).max(limits.actionDelayMs).optional(),
  }),
});

export const ScrollActionSchema = actionWithLoopUntil.extend({
  type: z.literal("scroll"),
  data: z.object({
    x: z.number().optional(),
    y: z.number().optional(),
  }),
});

export const WaitActionSchema = z.object({
  type: z.literal("wait"),
  data: z.object({
    until: z
      .enum([
        "timeout",
        "domcontentloaded",
        "networkidle0",
        "networkidle2",
        "selector",
      ])
      .optional(),
    ms: z.number().int().min(0).max(limits.actionDelayMs).optional(),
    selector: boundedSelector.optional(),
    visible: z.boolean().optional(),
    timeout: z.number().int().min(1).max(limits.actionDelayMs).optional(),
  }),
});

export const InputActionSchema = z.object({
  type: z.literal("input"),
  data: z.object({
    selector: boundedSelector,
    text: z.string().max(limits.textLength),
  }),
});

export const BlockElementActionSchema = z.object({
  type: z.literal("block"),
  data: z.object({
    selector: boundedSelector,
  }),
});

export const ActionSchema = z.union([
  ClickActionSchema,
  ScrollActionSchema,
  WaitActionSchema,
  InputActionSchema,
  BlockElementActionSchema,
]);

export type Action = z.infer<typeof ActionSchema>;

export const ProjectConfigSchema = z.object({
  outDir: z.string().max(512).nullish(),
  fontDecryptMap: z.record(z.string(), z.string()).nullish(),
});

///////////////////////////

export const ProjectSchema = z.object({
  id: z.uuidv7(),
  title: z.string(),
  author: z.string(),
  cover: z.string(),
  config: ProjectConfigSchema.nullish(),
  language: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const CreateProjectReqSchema = ProjectSchema.pick({
  title: true,
  author: true,
});

export const CreateProjectResSchema = ProjectSchema.pick({ id: true });

export const UpdateProjectReqSchema = ProjectSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial();

////////////////////

export const SnapshotRequestSchema = z.object({
  url: z.string().min(1, { message: "url is required" }),
  width: z.number().int().min(1).max(limits.viewportDimension).optional(),
  height: z.number().int().min(1).max(limits.viewportDimension).optional(),
  isFullPage: z.boolean().optional(),
  actions: z.array(ActionSchema).max(limits.browserActions).optional(),
  anchorTextContains: z.boolean().optional(),
  ignoreDuplicates: z.boolean().optional(),
  blockList: z.array(boundedSelector).max(limits.blockSelectors).optional(),
});

const extractRequestSelectors = z.object(
  {
    chapter: z.string().min(1, { message: "chapter selector is required" }),
    content: contentSelectorList,
    framePath: z.string().min(1).array().max(limits.frames).optional(),
  },
  { error: "selectors is required" },
);

export const ExtractRequestSchema = z.object({
  title: z.string().min(1, { message: "title is required" }),
  cover: z.string().optional(),
  author: z.string().optional(),
  chapters: z
    .object({
      title: z.string().min(1, { message: "title is required" }),
      url: z.string().min(1, { message: "url is required" }),
    })
    .array()
    .min(1, { message: "at least one chapter is required" }),
  selectors: extractRequestSelectors,
  delayChapter: z.number().optional(),
});

export const ExtractResponseSchema = z.object({
  taskId: z.uuidv7(),
});

export const TranslateRequestSchema = z.object({
  text: z.string().min(1, { message: "text is required" }).max(limits.textLength),
  to: z.string().min(2).max(35).optional(),
});

export const TranslateResponseSchema = z.object({
  result: z.string(),
});
