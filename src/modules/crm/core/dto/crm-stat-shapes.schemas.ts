import { z } from "zod";

export const trendSchema = z.object({
  value: z.number(),
  isPositive: z.boolean(),
});

export const personStatSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  trend: trendSchema.optional(),
});

export const statWithTrendSchema = z.object({
  value: z.union([z.number(), z.string()]),
  trend: trendSchema,
});
