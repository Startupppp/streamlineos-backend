import { z } from "zod";

export const createLiveSessionSchema = z.object({
  settings: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const joinLiveSessionSchema = z.object({
  name: z.string().max(200).optional(),
  email: z.string().email().optional(),
}).strict();

export const submitLiveAnswerSchema = z.object({
  participantToken: z.string(),
  questionId: z.number().int().positive(),
  answerValue: z.unknown().optional(),
  choiceIds: z.array(z.number().int().positive()).max(50).optional(),
}).strict();

export type CreateLiveSessionInput = z.infer<typeof createLiveSessionSchema>;
export type JoinLiveSessionInput = z.infer<typeof joinLiveSessionSchema>;
export type SubmitLiveAnswerInput = z.infer<typeof submitLiveAnswerSchema>;
