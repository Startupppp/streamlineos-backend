import { z } from "zod";

const questionSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1).max(2000),
  type: z.enum(["rating", "text"]),
});

export const createCycleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.string().max(50).optional(),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  isAnonymous: z.boolean().optional(),
  questions: z.array(questionSchema).optional(),
});
export type CreateCycleInput = z.infer<typeof createCycleSchema>;

export const updateCycleStatusSchema = z.object({
  status: z.string().trim().min(1).max(50),
});
export type UpdateCycleStatusInput = z.infer<typeof updateCycleStatusSchema>;

const responseSchema = z.object({
  questionId: z.string().min(1),
  rating: z.number().int().min(1).max(10).optional(),
  text: z.string().max(5000).optional(),
});

export const submitResponseSchema = z.object({
  responses: z.array(responseSchema).min(1),
  overallRating: z.number().int().min(1).max(10).optional(),
});
export type SubmitResponseInput = z.infer<typeof submitResponseSchema>;
