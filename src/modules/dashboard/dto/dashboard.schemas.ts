import { z } from "zod";

export const myIssuesSchema = z.object({
  userId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const createAnnouncementSchema = z.object({
  content: z.string().min(1).max(2000),
  isPinned: z.boolean().optional(),
  expiresAt: z.string().datetime().optional(),
});

export const deleteAnnouncementSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type MyIssuesInput = z.infer<typeof myIssuesSchema>;
export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;
export type DeleteAnnouncementInput = z.infer<typeof deleteAnnouncementSchema>;
