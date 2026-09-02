import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

export const createSchema = z.object({
  title: z.string().min(1).max(200),
  question: z.string().min(1).optional(),
  clientId: z.number().int().positive().optional(),
  scaleMax: z.union([z.literal(5), z.literal(10)]).optional().default(5),
}).strict();

export const patchSchema = z.object({
  status: z.enum(["sent", "closed"]).optional(),
  title: z.string().min(1).max(200).optional(),
  question: z.string().min(1).optional(),
}).strict();

export const listResponsesSchema = z.object({
  limit: pageSizeField(200),
}).strict();

export const submitResponseSchema = z.object({
  rating: z.number().int().min(1).max(10),
  comment: z.string().optional(),
  respondentName: z.string().optional(),
  respondentEmail: z.string().email().optional(),
}).strict();

export type CreateInput = z.infer<typeof createSchema>;
export type PatchInput = z.infer<typeof patchSchema>;
export type ListResponsesInput = z.infer<typeof listResponsesSchema>;
export type SubmitResponseInput = z.infer<typeof submitResponseSchema>;
