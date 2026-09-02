import { z } from "zod";

export const generatePeriodsSchema = z.object({
  year: z.number().int().min(2000).max(2100),
}).strict();

export type GeneratePeriodsInput = z.infer<typeof generatePeriodsSchema>;
