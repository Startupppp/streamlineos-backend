import { z } from "zod";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const teamWeekSummaryQuerySchema = z.object({
  userIds: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().min(1)).min(1).max(100)),
  startDate: dateString,
  endDate: dateString,
}).strict();
export type TeamWeekSummaryQuery = z.infer<typeof teamWeekSummaryQuerySchema>;
