import { z } from "zod";

export const createMentorshipSchema = z.object({
  mentorId: z.string().uuid(),
  menteeId: z.string().uuid(),
  goal: z.string().max(2000).optional(),
  startedAt: z.string().datetime({ offset: true }).optional(),
});
export type CreateMentorshipInput = z.infer<typeof createMentorshipSchema>;

export const updateMentorshipSchema = z.object({
  status: z.string().max(50).optional(),
  endedAt: z.string().datetime({ offset: true }).optional(),
  goal: z.string().max(2000).optional(),
});
export type UpdateMentorshipInput = z.infer<typeof updateMentorshipSchema>;
