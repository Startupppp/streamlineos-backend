import { z } from "zod";

export const analyticsQuerySchema = z.object({
  period: z.enum(["3m", "6m", "12m"]).default("6m"),
});
