import { z } from "zod";

export const surveyResponseSubmittedPayloadSchema = z.object({
  sessionId: z.number().int().positive(),
  surveyId: z.number().int().positive(),
  orgId: z.string().min(1),
  score: z.number().int().nullable(),
  passed: z.boolean().nullable(),
});

export type SurveyResponseSubmittedPayload = z.infer<
  typeof surveyResponseSubmittedPayloadSchema
>;
