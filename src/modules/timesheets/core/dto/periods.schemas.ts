import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { timesheetPeriodStatusSchema } from "./status.schemas";

export const periodsQuerySchema = z.object({
  userId: z.string().optional(),
  status: timesheetPeriodStatusSchema.optional(),
  limit: pageSizeField(20),
});
export type PeriodsQuery = z.infer<typeof periodsQuerySchema>;
