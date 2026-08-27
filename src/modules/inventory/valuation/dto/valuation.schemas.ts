import { z } from "zod";

export const valuationSummarySchema = z.object({
  warehouseId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ValuationSummaryInput = z.infer<typeof valuationSummarySchema>;

export const valuationLayersSchema = z.object({
  variantId: z.coerce.number().int().positive(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type ValuationLayersInput = z.infer<typeof valuationLayersSchema>;
