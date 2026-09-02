import { z } from "zod";

export const upsertCommentDraftSchema = z.object({
  body: z.string().min(1).max(10_000),
}).strict();

export type UpsertCommentDraftInput = z.infer<typeof upsertCommentDraftSchema>;
