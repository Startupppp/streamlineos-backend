import { z } from "zod";

export const periodsQuerySchema = z.object({
  userId: z.string().optional(),
  status: z
    .enum(["OPEN", "DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "LOCKED"])
    .optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type PeriodsQuery = z.infer<typeof periodsQuerySchema>;
