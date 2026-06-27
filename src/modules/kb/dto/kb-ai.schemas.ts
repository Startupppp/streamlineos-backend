import { z } from "zod";

export const searchSchema = z.object({
  q: z.string().trim().min(1).max(200),
  spaceId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchInput = z.infer<typeof searchSchema>;

export const askSchema = z.object({
  question: z.string().trim().min(3).max(1000),
  spaceId: z.coerce.number().int().positive().optional(),
});
export type AskInput = z.infer<typeof askSchema>;
