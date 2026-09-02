import { z } from "zod";

export const createChecklistSchema = z.object({
  title: z.string().min(1).max(200).default("Checklist"),
}).strict();

export const updateChecklistSchema = z.object({
  title: z.string().min(1).max(200),
}).strict();

export const createChecklistItemSchema = z.object({
  text: z.string().min(1).max(500),
  assigneeId: z.string().optional(),
  dueDate: z.string().optional().nullable(),
  order: z.number().int().default(0),
}).strict();

export const updateChecklistItemSchema = z.object({
  text: z.string().min(1).max(500).optional(),
  isCompleted: z.boolean().optional(),
  assigneeId: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  order: z.number().int().optional(),
}).strict();

export type CreateChecklistInput = z.infer<typeof createChecklistSchema>;
export type UpdateChecklistInput = z.infer<typeof updateChecklistSchema>;
export type CreateChecklistItemInput = z.infer<typeof createChecklistItemSchema>;
export type UpdateChecklistItemInput = z.infer<typeof updateChecklistItemSchema>;
