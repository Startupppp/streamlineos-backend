import { z } from "zod";

export const startSessionSchema = z.object({
  accessToken: z.string().optional(),
  participantEmail: z.string().email().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const saveAnswerSchema = z.object({
  questionId: z.number().int().positive(),
  answerValue: z.unknown().optional(),
  answerText: z.string().max(10000).optional(),
  choiceIds: z.array(z.number().int().positive()).max(50).optional(),
});

export const patchSessionSchema = z.object({
  answers: z.array(saveAnswerSchema).min(1).max(200),
});

export const submitSessionSchema = z.object({
  answers: z.array(saveAnswerSchema).optional(),
});

export type StartSessionInput = z.infer<typeof startSessionSchema>;
export type SaveAnswerInput = z.infer<typeof saveAnswerSchema>;
export type PatchSessionInput = z.infer<typeof patchSessionSchema>;
export type SubmitSessionInput = z.infer<typeof submitSessionSchema>;
