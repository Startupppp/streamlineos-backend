import { z } from "zod";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");
const MENTORSHIP_STATUSES = ["active", "completed", "paused"] as const;

export const createMentorshipSchema = z
  .object({
    mentorId: z.string().trim().min(1, "Mentor is required"),
    menteeId: z.string().trim().min(1, "Mentee is required"),
    goal: z.string().trim().max(1000, "Goal must be at most 1000 characters").optional(),
    startedAt: dateOnly.optional(),
  })
  .refine((d) => d.mentorId !== d.menteeId, {
    message: "Mentor and mentee must be different people",
    path: ["menteeId"],
  });

export const updateMentorshipSchema = z.object({
  status: z.enum(MENTORSHIP_STATUSES).optional(),
  endedAt: dateOnly.optional(),
  goal: z.string().trim().max(1000, "Goal must be at most 1000 characters").optional(),
});

export type CreateMentorshipInput = z.infer<typeof createMentorshipSchema>;
export type UpdateMentorshipInput = z.infer<typeof updateMentorshipSchema>;
