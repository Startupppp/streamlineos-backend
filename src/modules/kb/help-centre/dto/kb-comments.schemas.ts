import { z } from "zod";

export const createCommentSchema = z.object({
  content: z.string().min(1).max(5000),
  parentId: z.number().int().positive().optional().nullable(),
}).strict();
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = z.object({
  content: z.string().min(1).max(5000),
}).strict();
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;
