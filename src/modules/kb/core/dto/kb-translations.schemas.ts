import { z } from "zod";

const KB_TRANSLATION_STATUSES = ["draft", "in_progress", "translated", "published", "outdated"] as const;

export const upsertTranslationSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().default(""),
  contentText: z.string().default(""),
  excerpt: z.string().max(500).optional().nullable(),
  status: z.enum(KB_TRANSLATION_STATUSES).optional(),
}).strict();
export type UpsertTranslationInput = z.infer<typeof upsertTranslationSchema>;
