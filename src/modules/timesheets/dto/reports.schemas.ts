import { z } from "zod";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const overviewQuerySchema = z.object({
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  userId: z.string().optional(),
});
export type OverviewQuery = z.infer<typeof overviewQuerySchema>;
