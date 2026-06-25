import { z } from "zod";

export const createSchema = z.object({
  title: z.string().min(1).max(200),
  question: z.string().min(1).optional(),
  clientId: z.number().int().positive().optional(),
  scaleMax: z.union([z.literal(5), z.literal(10)]).optional().default(5),
});

export const patchSchema = z.object({
  status: z.enum(["sent", "closed"]).optional(),
  title: z.string().min(1).max(200).optional(),
  question: z.string().min(1).optional(),
});

export const listResponsesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const submitResponseSchema = z.object({
  rating: z.number().int().min(1).max(10),
  comment: z.string().optional(),
  respondentName: z.string().optional(),
  respondentEmail: z.string().email().optional(),
});

export type CreateInput = z.infer<typeof createSchema>;
export type PatchInput = z.infer<typeof patchSchema>;
export type ListResponsesInput = z.infer<typeof listResponsesSchema>;
export type SubmitResponseInput = z.infer<typeof submitResponseSchema>;
