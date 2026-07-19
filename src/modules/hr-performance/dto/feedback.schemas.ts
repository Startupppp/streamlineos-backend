import { z } from "zod";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date");

const CYCLE_TYPES = ["360", "PEER", "UPWARD", "DOWNWARD"] as const;
const CYCLE_STATUSES = ["DRAFT", "ACTIVE", "CLOSED", "ARCHIVED"] as const;

const feedbackQuestionSchema = z.object({
  id: z.string().trim().min(1, "Question id is required"),
  text: z
    .string()
    .trim()
    .min(1, "Question text is required")
    .max(500, "Question text must be at most 500 characters"),
  type: z.enum(["rating", "text"]),
});

export const createFeedbackCycleSchema = z
  .object({
    name: z.string().trim().min(1, "Cycle name is required").max(200, "Cycle name must be at most 200 characters"),
    type: z.enum(CYCLE_TYPES).optional().default("360"),
    startDate: dateOnly,
    endDate: dateOnly,
    isAnonymous: z.boolean().optional().default(true),
    questions: z.array(feedbackQuestionSchema).max(50, "At most 50 questions are allowed").optional(),
  })
  .refine((d) => d.endDate >= d.startDate, {
    message: "End date must be on or after start date",
    path: ["endDate"],
  });

export const updateCycleStatusSchema = z.object({
  status: z.enum(CYCLE_STATUSES),
});

export const submitFeedbackResponseSchema = z.object({
  responses: z
    .array(
      z.object({
        questionId: z.string().trim().min(1, "Question id is required"),
        rating: z.number().int().min(1).max(5).optional(),
        text: z.string().trim().max(2000, "Response must be at most 2000 characters").optional(),
      }),
    )
    .min(1, "At least one response is required")
    .max(50, "At most 50 responses are allowed"),
  overallRating: z.number().int().min(1).max(5).optional(),
});

export type CreateFeedbackCycleInput = z.infer<typeof createFeedbackCycleSchema>;
export type UpdateCycleStatusInput = z.infer<typeof updateCycleStatusSchema>;
export type SubmitFeedbackResponseInput = z.infer<typeof submitFeedbackResponseSchema>;
