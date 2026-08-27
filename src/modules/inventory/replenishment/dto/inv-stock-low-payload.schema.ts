import { z } from "zod";

export const invStockLowPayloadSchema = z.object({
  productVariantId: z.number().int().positive(),
  onHand: z.string().min(1),
  reorderPoint: z.string().nullable(),
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
}).strict();

export type InvStockLowPayload = z.infer<typeof invStockLowPayloadSchema>;
