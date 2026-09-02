import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

export const periodsQuerySchema = z.object({
  userId: z.string().optional(),
  status: z
    .enum(["OPEN", "DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "LOCKED"])
    .optional(),
  limit: pageSizeField(20),
}).strict();
export type PeriodsQuery = z.infer<typeof periodsQuerySchema>;
