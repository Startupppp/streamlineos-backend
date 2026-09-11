import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export const insightsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
}).strict();

export type InsightsQuery = z.infer<typeof insightsQuerySchema>;
