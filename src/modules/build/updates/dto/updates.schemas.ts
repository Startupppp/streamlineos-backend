import { z } from "zod";

export const createUpdateSchema = z.object({
  body: z.string().min(1).max(10000),
}).strict();

export const editUpdateSchema = z.object({
  body: z.string().min(1).max(10000),
}).strict();

export const listUpdatesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  authorId: z.coerce.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.enum(["draft", "published"]).optional(),
}).strict();

export type CreateUpdateInput = z.infer<typeof createUpdateSchema>;
export type EditUpdateInput = z.infer<typeof editUpdateSchema>;
export type ListUpdatesQuery = z.infer<typeof listUpdatesQuerySchema>;
