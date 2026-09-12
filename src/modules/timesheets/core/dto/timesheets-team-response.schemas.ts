import { z } from "zod";
import { timesheetPeriodSchema } from "./timesheets-approvals-response.schemas";

export const teamSummaryResponseSchema = z.object({
  summaries: z.array(z.object({
    userId: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    period: timesheetPeriodSchema.nullable(),
    dailyHours: z.record(z.string(), z.number()),
    totalHours: z.number(),
  })),
});
