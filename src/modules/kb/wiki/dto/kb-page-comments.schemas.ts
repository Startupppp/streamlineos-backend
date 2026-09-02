import { z } from "zod";

export const createPageCommentSchema = z.object({
  content: z.string().min(1).max(5000),
  parentId: z.number().int().positive().nullable().optional(),
}).strict();
export type CreatePageCommentInput = z.infer<typeof createPageCommentSchema>;

export const updatePageCommentSchema = z.object({
  content: z.string().min(1).max(5000),
}).strict();
export type UpdatePageCommentInput = z.infer<typeof updatePageCommentSchema>;
