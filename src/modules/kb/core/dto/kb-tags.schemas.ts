import { z } from "zod";

export const createTagSchema = z.object({
  name: z.string().min(1).max(50),
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const setArticleTagsSchema = z.object({
  tagIds: z.array(z.number().int().positive()).max(50),
});
export type SetArticleTagsInput = z.infer<typeof setArticleTagsSchema>;
