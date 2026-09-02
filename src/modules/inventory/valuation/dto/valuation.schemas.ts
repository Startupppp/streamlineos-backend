import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const valuationSummarySchema = z.object({
  warehouseId: z.coerce.number().int().positive().optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type ValuationSummaryInput = z.infer<typeof valuationSummarySchema>;

export const valuationLayersSchema = z.object({
  variantId: z.coerce.number().int().positive(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type ValuationLayersInput = z.infer<typeof valuationLayersSchema>;
