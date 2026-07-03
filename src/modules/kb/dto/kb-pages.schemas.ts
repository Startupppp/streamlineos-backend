import { z } from "zod";

const tipTapContent = z.record(z.string(), z.unknown());

export const createPageSchema = z.object({
  parentPageId: z.coerce.number().int().positive().nullable().optional(),
  title: z.string().max(500).optional(),
  templateId: z.coerce.number().int().positive().nullable().optional(),
});
export type CreatePageInput = z.infer<typeof createPageSchema>;

export const updatePageSchema = z.object({
  title: z.string().max(500).optional(),
  icon: z.string().max(100).nullable().optional(),
  coverImage: z.string().max(2000).nullable().optional(),
  content: tipTapContent.optional(),
  contentText: z.string().max(200000).optional(),
});
export type UpdatePageInput = z.infer<typeof updatePageSchema>;

export const movePageSchema = z.object({
  parentPageId: z.coerce.number().int().positive().nullable(),
  index: z.coerce.number().int().min(0).default(0),
});
export type MovePageInput = z.infer<typeof movePageSchema>;

export const lockPageSchema = z.object({
  isLocked: z.boolean(),
});
export type LockPageInput = z.infer<typeof lockPageSchema>;

export const searchPagesSchema = z.object({
  q: z.string().trim().max(200).default(""),
});
export type SearchPagesInput = z.infer<typeof searchPagesSchema>;
