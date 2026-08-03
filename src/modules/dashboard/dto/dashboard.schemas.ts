import { z } from "zod";

export const createAnnouncementSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(2000),
  isPinned: z.boolean().optional(),
  expiresAt: z.string().datetime().optional(),
});

export const deleteAnnouncementSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;
export type DeleteAnnouncementInput = z.infer<typeof deleteAnnouncementSchema>;
