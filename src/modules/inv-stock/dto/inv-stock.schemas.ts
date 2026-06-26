import { z } from "zod";

export const listStockLevelsSchema = z.object({
  warehouseId: z.coerce.number().int().positive().optional(),
  productId: z.coerce.number().int().positive().optional(),
  lowStock: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListStockLevelsInput = z.infer<typeof listStockLevelsSchema>;

export const listTransactionsSchema = z.object({
  productVariantId: z.coerce.number().int().positive().optional(),
  locationId: z.coerce.number().int().positive().optional(),
  transactionType: z.enum(["PURCHASE", "SALE", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "TRANSFER_IN", "TRANSFER_OUT", "RETURN_IN", "RETURN_OUT", "GRN"]).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListTransactionsInput = z.infer<typeof listTransactionsSchema>;

export const adjustmentLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  locationId: z.number().int().positive(),
  quantityChange: z.number().refine((v) => v !== 0, { message: "must not be zero" }),
  notes: z.string().max(500).optional(),
});

export const createAdjustmentSchema = z.object({
  reason: z.enum(["PURCHASE", "SALE", "RETURN", "DAMAGE", "EXPIRY", "THEFT", "RECOUNT", "OTHER"]),
  notes: z.string().max(1000).optional(),
  lines: z.array(adjustmentLineSchema).min(1),
});
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;

export const transferLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  quantity: z.number().positive(),
});

export const createTransferSchema = z.object({
  fromLocationId: z.number().int().positive(),
  toLocationId: z.number().int().positive(),
  notes: z.string().max(1000).optional(),
  lines: z.array(transferLineSchema).min(1),
});
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

export const completeTransferSchema = z.object({
  lines: z.array(z.object({
    transferLineId: z.number().int().positive(),
    quantityReceived: z.number().min(0),
  })).min(1),
});
export type CompleteTransferInput = z.infer<typeof completeTransferSchema>;
